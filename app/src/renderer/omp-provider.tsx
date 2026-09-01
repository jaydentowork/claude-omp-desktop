// Renderer-side transcript store. The hot IPC stream (`Transport`) lands here
// as `{seq, frames}` envelopes; this module folds each frame through a
// `Coalescer` into a `TranscriptModel` and exposes the model via React
// context. Components read rows via `useSyncExternalStore` on the model's
// `revision` counter, so a settled row's React subtree never re-renders.
//
// The four-rule ordering contract (`docs/transcript-rendering.md` §4.2) is
// enforced by `Coalescer`; the flush *timing* is one `requestAnimationFrame`
// per `Coalescer.flush()` call. Tail rendering is therefore at most one
// paint per display frame, never one per token.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Coalescer,
  TranscriptModel,
  decodeEventValue,
  historyRows,
  type ChatMessage,
} from '../main/omp-rpc';
// Value imports below are cycle-safe: those modules import only *types* from
// this one, which are erased at compile time.
import { RpcClient } from './rpc-client';
import { SubagentStore } from './subagent-store';
import { SwitcherStore } from './switcher-store';

export interface StreamFrame {
  readonly kind: string;
  readonly payload: unknown;
}

export interface StreamBatch {
  readonly seq: number;
  readonly frames: StreamFrame[];
}

export interface OmpBridge {
  subscribe(cb: (batch: unknown) => void): () => void;
  send(command: unknown): void;
}

declare global {
  interface Window {
    omp?: OmpBridge;
  }
}

export interface StreamState {
  /** Sequence of the last applied batch; gaps mean main dropped under load. */
  readonly lastSeq: number;
  /** Batch envelopes delivered to the renderer (i.e. post-coalesce count). */
  readonly batchesDelivered: number;
  /** Total frames folded in. */
  readonly framesReceived: number;
  /** True once a non-contiguous `seq` has been observed since the last
   * resync. Sticky until cleared — the UI banner drives a `resync()` which
   * re-issues `get_state` and clears the flag. */
  readonly gapDetected: boolean;
}

const INITIAL: StreamState = {
  lastSeq: 0,
  batchesDelivered: 0,
  framesReceived: 0,
  gapDetected: false,
};

export interface TranscriptStoreState extends StreamState {
  readonly messages: readonly ChatMessage[];
  readonly streaming: boolean;
  readonly history: HistoryPaging;
}

/**
 * History-paging phases (spec §7). `initial` shows the skeleton row;
 * `idle`+`hasMore` shows the "Load earlier messages…" pill; `busy` replaces
 * the pill with the quiet lock message and retries on the next terminal
 * `agent_end` / `auto_compaction_end`.
 */
export type HistoryPaging =
  | { phase: 'initial' }
  | { phase: 'idle'; hasMore: boolean }
  | { phase: 'loading'; hasMore: boolean }
  | { phase: 'busy'; hasMore: boolean };

/** A slow `get_messages_page` can't be cancelled (RPC gap #5) — time the
 * initial request out locally so replay/dev sessions without a live server
 * drop the skeleton row. */
const INITIAL_PAGE_TIMEOUT_MS = 10_000;

/** Page size for `get_messages_page` — the server max (spec §7.1). */
const PAGE_LIMIT = 256;

/** Single source of truth for the renderer. Subscribes to bridge batches,
 * feeds them through the coalescer into the model, and flushes pending
 * `message_update`s once per animation frame.
 *
 * `subscribe(fn)` notifies after every model mutation OR seq-advance; the
 * `getState` snapshot is cheap to read so components can pick the fields
 * they need. */
export class TranscriptStore {
  private seqState: StreamState = INITIAL;
  private listeners = new Set<() => void>();
  /** Listeners that receive every raw frame from every batch. Used by the
   * subagent panel and the model/thinking switcher to react to events the
   * transcript pipeline drops (`decodeEventValue` folds anything non-message
   * into `{event:'other'}`). Per-store, not per-frame, so each external store
   * pulls only what it cares about. */
  private frameListeners = new Set<(frame: StreamFrame) => void>();
  send: ((command: unknown) => void) | null = null;

  readonly model = new TranscriptModel();
  private readonly coalescer = new Coalescer();
  private rafHandle: number | null = null;

  // --- history paging (spec §7) ---
  private history: HistoryPaging = { phase: 'initial' };
  /** Opaque server cursor for the next-older page; null = no more pages. */
  private nextCursor: string | null = null;
  /** Correlation id of the in-flight page request; responses are matched on
   * id, never on order (docs/rpc-events.md §0). */
  private pageId: string | null = null;
  private pageCounter = 0;
  /** Set when a `session_busy` page failed; the next terminal `agent_end` /
   * `auto_compaction_end` re-issues it (spec §7.1 step 5). */
  private retryOnIdle = false;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Cached snapshot — `useSyncExternalStore` requires referential stability
   * between notifications, and rebuilding per read would loop React. */
  private snapshot: TranscriptStoreState = {
    ...INITIAL,
    messages: [],
    streaming: false,
    history: { phase: 'initial' },
  };

  getState = (): TranscriptStoreState => this.snapshot;

  private notify(): void {
    this.snapshot = {
      ...this.seqState,
      // Fresh array reference so memoized rows diff by element identity;
      // settled row objects are stable, only the streaming tail mutates.
      messages: [...this.model.messages],
      streaming: this.model.streaming,
      history: this.history,
    };
    for (const l of this.listeners) l();
  }

  /** Issue the no-cursor initial page (spec §7.1 steps 1–3). Skeleton shows
   * until the response lands or the local timeout gives up (replay/dev
   * sessions have no server to answer). */
  startHistory(): void {
    if (this.history.phase !== 'initial' || this.pageId !== null) return;
    this.requestPage(null);
    this.notify();
    this.initialTimeout = setTimeout(() => {
      this.initialTimeout = null;
      if (this.history.phase !== 'initial') return;
      // Hide the replay/dev skeleton, but keep the correlation id so a slow
      // live-server response can still be merged when it eventually arrives.
      this.history = { phase: 'idle', hasMore: false };
      this.notify();
    }, INITIAL_PAGE_TIMEOUT_MS);
  }

  /** Page in the next-older 256 messages. Called from the scroll listener
   * (within 200 px of the top) and the "Load earlier" pill. */
  loadEarlier(): void {
    if (this.history.phase !== 'idle' || !this.history.hasMore) return;
    if (this.nextCursor === null) return;
    this.history = { phase: 'loading', hasMore: true };
    this.requestPage(this.nextCursor);
    this.notify();
  }

  private requestPage(cursor: string | null): void {
    this.pageId = `history:${++this.pageCounter}`;
    this.send?.({
      id: this.pageId,
      type: 'get_messages_page',
      ...(cursor !== null ? { cursor } : {}),
      limit: PAGE_LIMIT,
    });
  }

  /** Response frame for the in-flight page request. */
  private onPageResponse(resp: {
    id?: string;
    success: boolean;
    data?: unknown;
    code?: string;
  }): void {
    if (resp.id !== this.pageId) return; // stale or foreign response
    this.pageId = null;
    if (this.initialTimeout !== null) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (resp.success) {
      const data = resp.data as { messages?: unknown; nextCursor?: unknown } | undefined;
      this.model.mergeHistory(historyRows(data?.messages, `p${this.pageCounter}`));
      this.nextCursor = typeof data?.nextCursor === 'string' ? data.nextCursor : null;
      // Only the absence of nextCursor means done — never a short page
      // (docs/rpc-events.md §5.2).
      this.history = { phase: 'idle', hasMore: this.nextCursor !== null };
    } else if (resp.code === 'session_busy') {
      // Retry after the turn/compaction ends (spec §7.1 step 5).
      this.retryOnIdle = true;
      this.history = { phase: 'busy', hasMore: true };
    } else {
      // stale_cursor (or anything unexpected): discard and restart from no
      // cursor (spec §7.1 step 6). The prepend dedupe by id makes the
      // re-fetched overlap harmless.
      this.nextCursor = null;
      if (resp.code === 'stale_cursor') {
        this.history = { phase: 'loading', hasMore: true };
        this.requestPage(null);
      } else {
        this.history = { phase: 'idle', hasMore: false };
      }
    }
    this.notify();
  }

  /** A `session_busy` retry fires once the session goes quiet. */
  private onSessionIdle(): void {
    if (!this.retryOnIdle) return;
    this.retryOnIdle = false;
    const cursor = this.nextCursor;
    this.history = { phase: 'loading', hasMore: true };
    this.requestPage(cursor);
  }

  apply = (batch: unknown): void => {
    const b = batch as StreamBatch;
    if (!b || !Array.isArray(b.frames)) return;
    const gapDetected = this.seqState.gapDetected || b.seq > this.seqState.lastSeq + 1;
    this.seqState = {
      lastSeq: b.seq,
      batchesDelivered: this.seqState.batchesDelivered + 1,
      framesReceived: this.seqState.framesReceived + b.frames.length,
      gapDetected,
    };
    for (const frame of b.frames) {
      // Raw-frame fan-out runs first: external listeners (RpcClient + stores)
      // see every frame, including paging responses, before any internal
      // bookkeeping that may `continue` out of this iteration.
      if (this.frameListeners.size > 0) {
        for (const l of this.frameListeners) l(frame);
      }
      if (frame.kind === 'response') {
        const resp = frame.payload as { id?: string; success?: boolean } | null;
        if (resp && typeof resp.success === 'boolean') {
          this.onPageResponse(resp as Parameters<typeof this.onPageResponse>[0]);
        }
        continue;
      }
      const event = decodeEventValue(frame.payload);
      for (const e of this.coalescer.feed(event)) this.model.apply(e);
      if (
        (event.event === 'agent_end' && event.isTerminal) ||
        frame.kind === 'auto_compaction_end'
      ) {
        this.onSessionIdle();
      }
    }
    // First live frames while still 'initial': the session is producing a
    // stream, so the skeleton must yield to the real rows (spec §7.3 —
    // streaming is independent of paging).
    if (this.history.phase === 'initial' && this.model.messages.length > 0) {
      this.history = { phase: 'idle', hasMore: false };
    }
    if (this.coalescer.hasPending()) this.scheduleFlush();
    this.notify();
  };

  /** Subscribe to every frame. Used by the subagent panel + switcher to see
   * events the transcript pipeline drops (`subagent_*`, `config_update`, etc.).
   * Returns the unsubscribe fn. */
  onFrame(cb: (frame: StreamFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  /** Re-request authoritative state after a seq gap and clear the flag. */
  resync = (): void => {
    this.send?.({ type: 'get_state' });
    if (!this.seqState.gapDetected) return;
    this.seqState = { ...this.seqState, gapDetected: false };
    this.notify();
  };

  toggleTool(toolCallId: string): void {
    this.model.toggleTool(toolCallId);
    this.notify();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private scheduleFlush(): void {
    if (this.rafHandle !== null) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      const event = this.coalescer.flush();
      if (event !== null) this.model.apply(event);
      this.notify();
    });
  }

  dispose(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    if (this.initialTimeout !== null) clearTimeout(this.initialTimeout);
    this.initialTimeout = null;
    this.coalescer.reset();
    // Reset paging state so a remounted provider re-issues the initial page
    // (spec §7.1 step 1) instead of inheriting a stale 'idle' / 'busy' phase.
    this.history = { phase: 'initial' };
    this.nextCursor = null;
    this.pageId = null;
    this.retryOnIdle = false;
  }
}

const TranscriptContext = createContext<TranscriptStore | null>(null);

interface PanelStores {
  rpc: RpcClient;
  subagents: SubagentStore;
  switcher: SwitcherStore;
}

const PanelContext = createContext<PanelStores | null>(null);

export function OmpProvider({
  children,
  bridge = window.omp,
}: {
  children: ReactNode;
  bridge?: OmpBridge;
}) {
  const storeRef = useRef<TranscriptStore>();
  const panelRef = useRef<PanelStores>();
  if (!storeRef.current) storeRef.current = new TranscriptStore();
  const store = storeRef.current;
  if (!panelRef.current) {
    panelRef.current = {
      rpc: new RpcClient(store),
      subagents: new SubagentStore(),
      switcher: new SwitcherStore(),
    };
  }
  const panels = panelRef.current;

  useEffect(() => {
    const offSub = panels.subagents.attach(store, panels.rpc);
    const offSwitch = panels.switcher.attach(store, panels.rpc);
    return () => {
      offSub();
      offSwitch();
    };
  }, [panels, store]);

  useEffect(() => {
    if (!bridge) return;
    store.send = bridge.send.bind(bridge);
    const unsubscribe = bridge.subscribe(store.apply);
    // Session open: kick off the no-cursor initial history page (spec §7.1).
    store.startHistory();
    return () => {
      store.send = null;
      unsubscribe();
      store.dispose();
    };
  }, [bridge, store]);

  return (
    <TranscriptContext.Provider value={store}>
      <PanelContext.Provider value={panels}>{children}</PanelContext.Provider>
    </TranscriptContext.Provider>
  );
}

export function usePanelStores(): PanelStores {
  const panels = useContext(PanelContext);
  if (!panels) throw new Error('usePanelStores requires <OmpProvider>');
  return panels;
}

export function useOmpStream(): TranscriptStoreState {
  const store = useContext(TranscriptContext);
  if (!store) throw new Error('useOmpStream requires <OmpProvider>');
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function useOmpStore(): TranscriptStore {
  const store = useContext(TranscriptContext);
  if (!store) throw new Error('useOmpStore requires <OmpProvider>');
  return store;
}

/** Dev-only notice that a batch gap was seen; issues the explicit resync. */
export function ResyncBanner() {
  const { gapDetected } = useOmpStream();
  const store = useOmpStore();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!gapDetected) return;
    setVisible(true);
    store.resync();
    const t = setTimeout(() => setVisible(false), 2000);
    return () => clearTimeout(t);
  }, [gapDetected, store]);

  if (!import.meta.env.DEV || !visible) return null;
  return (
    <div className="resync-banner" role="status">
      stream gap detected, re-reading state
    </div>
  );
}