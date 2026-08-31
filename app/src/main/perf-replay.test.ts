// Headless check for the synthetic perf source: the seed phase must land
// every row through Transport without tripping the drop-oldest cap, and the
// stream phase must keep exactly one streaming tail row. Uses fake timers —
// the Playwright spec is where real wall-clock behavior is measured.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfReplay, parsePerfReplayEnv } from './perf-replay';
import { Transport } from './transport';
import { TranscriptModel, decodeEventValue } from './omp-rpc';

type PortListener = (event: { data: unknown }) => void;

/** Minimal MessagePortMain stand-in delivering batches synchronously. */
function mockPort(onBatch: (batch: { seq: number; frames: Array<{ payload: unknown }> }) => void) {
  return {
    on(event: string, cb: PortListener) {
      void event;
      void cb;
    },
    postMessage(data: unknown) {
      onBatch(structuredClone(data) as { seq: number; frames: Array<{ payload: unknown }> });
    },
  } as never;
}

describe('PerfReplay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('seeds all rows and streams a single tail without dropping frames', () => {
    const transport = new Transport();
    const model = new TranscriptModel();
    transport.attach(
      mockPort((batch) => {
        for (const f of batch.frames) model.apply(decodeEventValue(f.payload));
      }),
    );

    const replay = new PerfReplay(transport, { rows: 5_000, streamMs: 480 });
    replay.start();
    // Seed (5000/120 → 42 ticks) + stream (30 ticks) + settle, at 16 ms each.
    vi.advanceTimersByTime(16 * (42 + 30 + 2) + 100);
    replay.dispose();
    transport.dispose();

    expect(transport.stats().droppedFrames).toBe(0);
    const seeded = model.messages.filter((m) => m.id.startsWith('seed-')).length;
    expect(seeded).toBe(5_000);
    // Stream rolled through several messages; all settled by the final end.
    const streaming = model.messages.filter((m) => m.row === 'text' && m.streaming).length;
    expect(streaming).toBe(0);
    expect(model.messages.filter((m) => m.id.startsWith('stream-')).length).toBeGreaterThan(1);
  });

  it('parsePerfReplayEnv accepts rows,streamMs and rejects junk', () => {
    expect(parsePerfReplayEnv('30000,10000')).toEqual({ rows: 30_000, streamMs: 10_000 });
    expect(parsePerfReplayEnv(undefined)).toBeNull();
    expect(parsePerfReplayEnv('')).toBeNull();
    expect(parsePerfReplayEnv('abc')).toBeNull();
    expect(parsePerfReplayEnv('10')).toBeNull();
    expect(parsePerfReplayEnv('-5,100')).toBeNull();
  });
});
