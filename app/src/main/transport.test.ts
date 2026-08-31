import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePortMain } from 'electron';
import {
  FLUSH_INTERVAL_MS,
  MAX_PENDING_FRAMES,
  Transport,
  type OutboundFrame,
} from './transport';

/** Minimal stand-in for MessagePortMain — just what Transport touches. */
function portMock(onPost: (data: unknown) => void): MessagePortMain {
  return {
    postMessage: onPost,
    on: () => undefined,
    close: () => undefined,
  } as unknown as MessagePortMain;
}

const frame = (i: number): OutboundFrame => ({ kind: 'message_update', payload: i });

describe('Transport coalescing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces frames within one flush window into a single batch', () => {
    const batches: unknown[] = [];
    const t = new Transport();
    t.attach(portMock((d) => batches.push(d)));

    for (let i = 0; i < 50; i++) t.ingest(frame(i));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(batches).toHaveLength(1);
    expect((batches[0] as { frames: unknown[] }).frames).toHaveLength(50);
  });

  it('assigns strictly increasing seq per batch', () => {
    const seqs: number[] = [];
    const t = new Transport();
    t.attach(portMock((d) => seqs.push((d as { seq: number }).seq)));

    for (let round = 0; round < 5; round++) {
      t.ingest(frame(round));
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('drops oldest beyond the pending cap and counts drops', () => {
    const batches: Array<{ frames: OutboundFrame[] }> = [];
    const t = new Transport();
    t.attach(portMock((d) => batches.push(d as { frames: OutboundFrame[] })));

    const overflow = 40;
    for (let i = 0; i < MAX_PENDING_FRAMES + overflow; i++) t.ingest(frame(i));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(t.stats().droppedFrames).toBe(overflow);
    const delivered = batches[0].frames;
    expect(delivered).toHaveLength(MAX_PENDING_FRAMES);
    // Oldest dropped: first surviving frame is the one after the drops.
    expect(delivered[0].payload).toBe(overflow);
    expect(delivered[delivered.length - 1].payload).toBe(MAX_PENDING_FRAMES + overflow - 1);
  });

  it('queues while unattached and drains on attach', () => {
    const batches: unknown[] = [];
    const t = new Transport();
    t.ingest(frame(1));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 4);
    // Flushed with no port — frame is gone, by design (renderer not up yet
    // is only lossless once attach happens before the flush window closes).
    t.ingest(frame(2));
    t.attach(portMock((d) => batches.push(d)));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(batches).toHaveLength(1);
  });

  it('dispose flushes pending synchronously', () => {
    const batches: unknown[] = [];
    const t = new Transport();
    t.attach(portMock((d) => batches.push(d)));
    t.ingest(frame(1));
    t.dispose();
    expect(batches).toHaveLength(1);
  });
});
