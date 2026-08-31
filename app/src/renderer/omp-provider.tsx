// Renderer side of the hot IPC stream. Main coalesces at ~16 ms and posts
// `{seq, frames}` envelopes; the provider folds them into a reducer store
// that components read via useSyncExternalStore.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

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
  /** Latest frame per kind — enough for the scaffold; the transcript model
   * (omp-rpc/transcript.ts) takes over interpretation in the next ticket. */
  readonly latestByKind: ReadonlyMap<string, StreamFrame>;
  /** True once a non-contiguous `seq` has been observed since the last
   * resync. Sticky until cleared — the UI banner drives a `resync()` which
   * re-issues `get_state` and clears the flag. */
  readonly gapDetected: boolean;
}

const INITIAL: StreamState = {
  lastSeq: 0,
  batchesDelivered: 0,
  framesReceived: 0,
  latestByKind: new Map(),
  gapDetected: false,
};

export function reduceBatch(state: StreamState, batch: StreamBatch): StreamState {
  const gapDetected =
    state.gapDetected || batch.seq > state.lastSeq + 1;
  const latestByKind = new Map(state.latestByKind);
  for (const frame of batch.frames) latestByKind.set(frame.kind, frame);
  return {
    lastSeq: batch.seq,
    batchesDelivered: state.batchesDelivered + 1,
    framesReceived: state.framesReceived + batch.frames.length,
    latestByKind,
    gapDetected,
  };
}

/** Minimal external store so components subscribe without re-render storms. */
export class StreamStore {
  private state: StreamState = INITIAL;
  private listeners = new Set<() => void>();
  /** Bound after construction by the provider; null in bridge-less tests. */
  send: ((command: unknown) => void) | null = null;

  getState = (): StreamState => this.state;

  apply = (batch: unknown): void => {
    const b = batch as StreamBatch;
    if (!b || !Array.isArray(b.frames)) return; // malformed envelope — ignore
    this.state = reduceBatch(this.state, b);
    for (const l of this.listeners) l();
  };

  /** Re-request authoritative state after a seq gap and clear the flag.
   * Never auto-issued by the reducer — always an explicit call (banner). */
  resync = (): void => {
    this.send?.({ op: 'get_state' });
    if (!this.state.gapDetected) return;
    this.state = { ...this.state, gapDetected: false };
    for (const l of this.listeners) l();
  };

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

const OmpContext = createContext<StreamStore | null>(null);

export function OmpProvider({
  children,
  bridge = window.omp,
}: {
  children: ReactNode;
  /** Injectable for tests; defaults to the preload bridge. */
  bridge?: OmpBridge;
}) {
  const storeRef = useRef<StreamStore>();
  if (!storeRef.current) storeRef.current = new StreamStore();
  const store = storeRef.current;

  useEffect(() => {
    if (!bridge) return; // preload absent (plain vitest jsdom) — inert
    store.send = bridge.send.bind(bridge);
    const unsubscribe = bridge.subscribe(store.apply);
    return () => {
      store.send = null;
      unsubscribe();
    };
  }, [bridge, store]);

  return <OmpContext.Provider value={store}>{children}</OmpContext.Provider>;
}

export function useOmpStream(): StreamState {
  const store = useContext(OmpContext);
  if (!store) throw new Error('useOmpStream requires <OmpProvider>');
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function useOmpStore(): StreamStore {
  const store = useContext(OmpContext);
  if (!store) throw new Error('useOmpStore requires <OmpProvider>');
  return store;
}

/** Dev-only notice that a batch gap was seen; issues the explicit resync.
 * Lightest UX that proves the signal travels — the real treatment lands
 * with the window-shell slice. */
export function ResyncBanner() {
  const { gapDetected } = useOmpStream();
  const store = useOmpStore();
  // resync() clears gapDetected synchronously, so hold the banner open
  // long enough for a human to see it during the manual kill-omp check.
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
