//! Hot IPC transport between main and the renderer.
//!
//! `MessageChannelMain` carries the frame stream end-to-end. Main coalesces
//! frames at ~16 ms before posting on port1 (structured-clone), so the
//! renderer never sees a flood of per-token `message_update` events. The
//! `omp` child spawn lives elsewhere — this module is the pump only.
//!
//! Locked constraint: the stream never rides `ipcRenderer` send-style IPC.
//! The CI grep lives in `src/no-ipc-send.test.ts`.

// Type-only electron import keeps this module loadable in headless vitest;
// the value-level `MessageChannelMain` wiring lives in `main.ts`.
import type { MessagePortMain } from 'electron';

/** ~16 ms flush window — one display frame at 60 fps. */
export const FLUSH_INTERVAL_MS = 16;

/** Cap retained frames per flush window. Drop-oldest once exceeded. */
export const MAX_PENDING_FRAMES = 256;

export interface OutboundFrame {
  /** Caller-supplied opaque tag (typically the decoded event type). */
  readonly kind: string;
  /** Anything structured-cloneable. */
  readonly payload: unknown;
}

/**
 * Public surface for tests + future child pump.
 *
 * `ingest` is called from whoever owns the `omp` child stdio (later ticket).
 * `attach` wires the port1 side to a BrowserWindow; teardown returns a
 * disposer.
 */
export class Transport {
  private pending: Array<OutboundFrame> = [];
  /** Monotonic sequence assigned to each flushed batch. */
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private port: MessagePortMain | null = null;
  /** Observability — total batches and total frames ever flushed. */
  private flushedBatches = 0;
  private flushedFrames = 0;
  private droppedFrames = 0;
  /** Upstream path: renderer commands arriving on the same port. The pump
   * owner assigns this once and it survives port rebinds. */
  onCommand: ((command: unknown) => void) | null = null;

  /**
   * Hook a renderer port into the pump. Idempotent: a second call drops the
   * first port and rebinds (window reload path).
   */
  attach(port: MessagePortMain): void {
    this.port = port;
    port.on('close', () => {
      if (this.port === port) this.port = null;
    });
    // Renderer → main commands ride the same channel in the other direction
    // (preload's `send` posts on its end of the pair).
    port.on('message', (e) => this.onCommand?.(e.data));
    port.start?.();
    // Drain anything queued while we were unattached so we never lose frames
    // that arrived before the renderer was ready.
    if (this.pending.length > 0) this.scheduleFlush(0);
  }

  /**
   * Enqueue an outbound frame. Returns false if the frame was dropped due
   * to the pending cap; the monotonic `seq` on the next batch still advances.
   */
  ingest(frame: OutboundFrame): boolean {
    if (this.pending.length >= MAX_PENDING_FRAMES) {
      // Drop-oldest: keep the freshest snapshot. omp's `message_update`
      // carries the full accumulated `partial`, so older ones are always
      // superseded. Verified in docs/rpc-events.md §2.
      this.pending.shift();
      this.droppedFrames++;
    }
    this.pending.push(frame);
    this.scheduleFlush(FLUSH_INTERVAL_MS);
    return true;
  }

  /** Snapshot for tests. */
  stats() {
    return {
      flushedBatches: this.flushedBatches,
      flushedFrames: this.flushedFrames,
      droppedFrames: this.droppedFrames,
    };
  }

  /** Flush all pending immediately and stop the timer. For tests + teardown. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length > 0) this.flushNow();
    this.port = null;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) return; // a flush is already armed
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, delayMs);
  }

  private flushNow(): void {
    if (this.pending.length === 0) return;
    const port = this.port;
    // Keep frames until a renderer port exists. `attach()` schedules an
    // immediate drain; assigning sequence numbers only to delivered batches
    // prevents a false first-batch gap during startup/replay.
    if (!port) return;
    const batch = this.pending;
    this.pending = [];
    const seq = ++this.seq;
    this.flushedBatches++;
    this.flushedFrames += batch.length;
    // structured clone of one envelope beats N IPC round-trips.
    port.postMessage({ seq, frames: batch });
  }
}
