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
  type ChatMessage,
} from '../main/omp-rpc';

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
}

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
  send: ((command: unknown) => void) | null = null;

  readonly model = new TranscriptModel();
  private readonly coalescer = new Coalescer();
  private rafHandle: number | null = null;
  /** Cached snapshot — `useSyncExternalStore` requires referential stability
   * between notifications, and rebuilding per read would loop React. */
  private snapshot: TranscriptStoreState = {
    ...INITIAL,
    messages: [],
    streaming: false,
  };

  getState = (): TranscriptStoreState => this.snapshot;

  private notify(): void {
    this.snapshot = {
      ...this.seqState,
      // Fresh array reference so memoized rows diff by element identity;
      // settled row objects are stable, only the streaming tail mutates.
      messages: [...this.model.messages],
      streaming: this.model.streaming,
    };
    for (const l of this.listeners) l();
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
      const event = decodeEventValue(frame.payload);
      for (const e of this.coalescer.feed(event)) this.model.apply(e);
    }
    if (this.coalescer.hasPending()) this.scheduleFlush();
    this.notify();
  };

  /** Re-request authoritative state after a seq gap and clear the flag. */
  resync = (): void => {
    this.send?.({ op: 'get_state' });
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
    this.coalescer.reset();
  }
}

const TranscriptContext = createContext<TranscriptStore | null>(null);

export function OmpProvider({
  children,
  bridge = window.omp,
}: {
  children: ReactNode;
  bridge?: OmpBridge;
}) {
  const storeRef = useRef<TranscriptStore>();
  if (!storeRef.current) storeRef.current = new TranscriptStore();
  const store = storeRef.current;

  useEffect(() => {
    if (!bridge) return;
    store.send = bridge.send.bind(bridge);
    const unsubscribe = bridge.subscribe(store.apply);
    return () => {
      store.send = null;
      unsubscribe();
      store.dispose();
    };
  }, [bridge, store]);

  return <TranscriptContext.Provider value={store}>{children}</TranscriptContext.Provider>;
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