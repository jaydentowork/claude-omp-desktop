// Synthetic 60 fps event source for the Playwright interactive perf check
// (`e2e/perf/60fps.spec.ts`). Spawn-less: emits through the live `Transport`
// exactly the way the omp child pump would, so the whole real pipeline —
// coalesce in main, MessageChannelMain structured clone, preload relay,
// renderer Coalescer + TranscriptModel + virtualized pane — is under test.
//
// Two phases:
//
// 1. **Seed**: settle `rows` messages as fast as the transport allows.
//    `Transport` drops-oldest above MAX_PENDING_FRAMES (256) per flush
//    window, so seeding paces itself at SEED_BATCH frames per 16 ms tick —
//    tens of thousands of rows land in a couple of seconds, none dropped.
// 2. **Stream**: for `streamMs`, emit one `message_update` snapshot per
//    16 ms tick against a streaming tail row, rolling to a fresh message
//    every ~200 ms. This is the sustained 60 events/s load the fps assertion
//    is measured under, with the full row backlog behind it.
//
// Teardown is symmetric with `OmpPump`: `dispose()` clears the timer.

import type { Transport } from './transport';

export interface PerfReplayOptions {
  /** Rows to settle in the seed phase (the "tens of thousands"). */
  rows: number;
  /** Wall-clock length of the 60 fps streaming phase, in ms. */
  streamMs: number;
}

/** Frames per seed tick. Two seed ticks can land inside one Transport flush
 * window under timer drift, so keep 2 × SEED_BATCH under MAX_PENDING_FRAMES
 * (256) — the drop-oldest cap must never fire during seeding. */
const SEED_BATCH = 120;
/** One display frame at 60 fps — same clock as Transport's flush window. */
const TICK_MS = 16;
/** Stream-phase ticks per message before rolling to a fresh row (~200 ms). */
const UPDATES_PER_MESSAGE = 12;

function endFrame(id: string, text: string) {
  return {
    type: 'message_end',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function updateFrame(id: string, text: string) {
  return {
    type: 'message_update',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
  };
}

export class PerfReplay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seeded = 0;
  private streamTicks = 0;
  private readonly streamTickBudget: number;

  constructor(
    private readonly transport: Transport,
    private readonly opts: PerfReplayOptions,
  ) {
    this.streamTickBudget = Math.ceil(opts.streamMs / TICK_MS);
  }

  /** Starts emission. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Halts emission and releases the timer. Safe to call repeatedly. */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.seeded < this.opts.rows) {
      const n = Math.min(SEED_BATCH, this.opts.rows - this.seeded);
      for (let i = 0; i < n; i++) {
        const ix = this.seeded + i;
        this.transport.ingest({
          kind: 'message_end',
          payload: endFrame(`seed-${ix}`, `seeded row ${ix}\n`),
        });
      }
      this.seeded += n;
      return;
    }
    if (this.streamTicks >= this.streamTickBudget) {
      // Settle the tail so the pane ends in a steady state, then stop.
      const id = `stream-${Math.floor((this.streamTicks - 1) / UPDATES_PER_MESSAGE)}`;
      this.transport.ingest({ kind: 'message_end', payload: endFrame(id, 'stream done\n') });
      this.dispose();
      return;
    }
    const msg = Math.floor(this.streamTicks / UPDATES_PER_MESSAGE);
    const rev = this.streamTicks % UPDATES_PER_MESSAGE;
    const id = `stream-${msg}`;
    if (rev === 0 && msg > 0) {
      // Roll: settle the previous streaming row before opening the next.
      this.transport.ingest({
        kind: 'message_end',
        payload: endFrame(`stream-${msg - 1}`, `streamed row ${msg - 1}\n`),
      });
    }
    // Growing snapshot — `message_update` carries the full accumulated text
    // (docs/rpc-events.md §2), so each tick's body strictly extends the last.
    this.transport.ingest({
      kind: 'message_update',
      payload: updateFrame(id, `streaming row ${msg}: ${'tok '.repeat(rev + 1)}\n`),
    });
    this.streamTicks += 1;
  }
}

/** Parses `OMP_PERF_REPLAY=rows,streamMs`. Null when unset or malformed. */
export function parsePerfReplayEnv(raw: string | undefined): PerfReplayOptions | null {
  if (raw === undefined || raw.length === 0) return null;
  const [rowsRaw, streamRaw] = raw.split(',');
  const rows = Number.parseInt(rowsRaw ?? '', 10);
  const streamMs = Number.parseInt(streamRaw ?? '', 10);
  if (!Number.isInteger(rows) || !Number.isInteger(streamMs) || rows <= 0 || streamMs <= 0) {
    return null;
  }
  return { rows, streamMs };
}
