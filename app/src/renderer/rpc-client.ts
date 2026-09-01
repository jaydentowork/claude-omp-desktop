// Renderer-side RPC command layer. Wraps the store's `send` with the id
// correlation the protocol requires (`docs/rpc-events.md` §0: match on `id`,
// never on emission order) and runs the spawn-order startup sequence when a
// `ready` frame arrives (negotiate v2, then notify stores to subscribe/seed).
//
// Commands the server never answers (unknown command → `id: undefined`) are
// covered by a per-request timeout — RPC gap #5: there is no cancellation
// for in-flight commands, so timing out client-side is the only option.

import type { Response } from '../main/omp-rpc';
import { supportsV2, type Ready } from '../main/omp-rpc';
import type { StreamFrame, TranscriptStore } from './omp-provider';

/** Per-request timeout. Nothing the panel/switcher sends is long-running. */
export const REQUEST_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyListeners = new Set<() => void>();
  private readonly store: TranscriptStore;

  constructor(store: TranscriptStore) {
    this.store = store;
    store.onFrame(this.onFrame);
  }

  /** Runs after every `ready` + protocol negotiation (initial spawn and any
   * future respawn). Stores register their subscribe/seed work here. */
  onReady(cb: () => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  /**
   * Send one command and resolve with its response. Rejects on timeout —
   * an unknown command answers with `id: undefined` and will never match.
   */
  request(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const id = `ui${this.nextId++}`;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      const send = this.store.send;
      if (send === null) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('RPC bridge not connected'));
        return;
      }
      send({ ...command, id });
    });
  }

  private onFrame = (frame: StreamFrame): void => {
    if (frame.kind === 'response') {
      const r = frame.payload as Response;
      if (r.id === undefined) return;
      const p = this.pending.get(r.id);
      if (p === undefined) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      p.resolve(r);
      return;
    }
    if (frame.kind === 'ready') {
      void this.handleReady(frame.payload as Ready);
    }
  };

  private async handleReady(ready: Ready): Promise<void> {
    // Spawn order (docs/rpc-events.md §0): negotiate v2 first — chunked
    // frames need it — then let stores subscribe and seed. Older builds
    // without v2 (or without negotiate at all) degrade silently.
    if (supportsV2(ready)) {
      try {
        await this.request({ type: 'negotiate_protocol', protocolVersion: 2 });
      } catch {
        // v1 keeps working for everything the panel + switcher need
      }
    }
    for (const l of this.readyListeners) l();
  }
}
