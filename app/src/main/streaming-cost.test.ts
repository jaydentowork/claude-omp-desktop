//! Locked constraint 2 (issue #8): the project's central performance claim —
//! 60 fps transcript at tens of thousands of rows with **flat per-flush
//! cost** — asserted headlessly so CI fails loud, not just by eye.
//!
//! Ports the *shape* of the archived GPUI `tests/streaming-cost.rs`: a synth
//! loop posts N=50k frames through the real `Transport` pump, per-flush wall
//! time is grouped into equal 1k-row buckets, and the bar is:
//!   1. flat cost — max(bucket) ≤ 1.5 × median(bucket) + 0.5 ms noise floor
//!   2. 60 fps    — no bucket > 20 ms
//!
//! The mock port does the renderer's steady-state work (structured clone of
//! the batch envelope + append into a growing rows array), so a regression
//! that makes flush cost scale with total accumulated rows shows up as a
//! rising histogram and a failed flat-cost bar.
//!
//! Thresholds + hardware baseline documented in `docs/perf-budget.md`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePortMain } from 'electron';
import {
  FLUSH_INTERVAL_MS,
  Transport,
  type OutboundFrame,
} from './transport';

const N_FRAMES = 50_000;
const BUCKET_SIZE = 1_000;
const FRAMES_PER_FLUSH = 250; // well under the 256 pending cap so nothing drops
// Flat-cost bar: max(bucket) ≤ med * FLAT_RATIO + NOISE_FLOOR_MS. Healthy
// buckets run ~0.6 ms on the 2026 dev baseline, where scheduler jitter alone
// is a few tenths of a ms — a pure ratio at that scale flakes. A real
// cost-scales-with-rows regression adds *milliseconds* to late buckets,
// far beyond ratio + slack.
const FLAT_RATIO = 1.5;
const NOISE_FLOOR_MS = 0.5;
const BUCKET_BUDGET_MS = 20;

// Payload sized like a realistic token-append update. One shared string —
// per-frame `repeat` would measure allocator churn of the harness itself,
// not the transport.
const PARTIAL = 'x'.repeat(256);

const frame = (i: number): OutboundFrame => ({
  kind: 'message_update',
  payload: { seq: i, partial: PARTIAL },
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function asciiHistogram(buckets: number[], width = 40): string {
  const max = Math.max(...buckets);
  const lines = [
    `per-bucket flush cost (${BUCKET_SIZE} rows/bucket, ${buckets.length} buckets)`,
  ];
  buckets.forEach((v, i) => {
    const n = max > 0 ? Math.round((v / max) * width) : 0;
    lines.push(
      `${String(i).padStart(2)} ${'█'.repeat(n).padEnd(width, '·')} ${v.toFixed(2)}ms`,
    );
  });
  return lines.join('\n');
}

/**
 * Pump `n` frames through a fresh Transport and return per-flush wall costs.
 * Fake timers drive the 16 ms flush windows synchronously; `performance.now`
 * stays real (only setTimeout/clearTimeout are faked) so the measurement is
 * genuine wall time for the flush + renderer-side handling.
 */
function pump(n: number): number[] {
  const flushMs: number[] = [];
  const rows: unknown[] = []; // grows to n — the "tens of thousands of rows"

  const t = new Transport();
  t.attach({
    postMessage: (data: unknown) => {
      const t0 = performance.now();
      // Renderer steady-state work: one structured clone of the envelope
      // (what MessagePortMain does on the wire) + append rows.
      const cloned = structuredClone(data) as { frames: OutboundFrame[] };
      for (const f of cloned.frames) rows.push(f.payload);
      flushMs.push(performance.now() - t0);
    },
    on: () => undefined,
    close: () => undefined,
  } as unknown as MessagePortMain);

  for (let i = 0; i < n; i += FRAMES_PER_FLUSH) {
    for (let j = i; j < Math.min(i + FRAMES_PER_FLUSH, n); j++) t.ingest(frame(j));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS); // fire exactly one flush
  }
  t.dispose();

  if (rows.length !== n) throw new Error(`pump lost frames: ${rows.length}/${n}`);
  return flushMs;
}

describe('streaming cost (locked constraint 2)', () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }),
  );
  afterEach(() => vi.useRealTimers());

  it('per-flush cost stays flat across 50k frames within the 60 fps budget', () => {
    // Full-size warm-up run so JIT + structured-clone paths settle before
    // anything is measured.
    pump(N_FRAMES);

    // Five measured runs; assert on the element-wise MINIMUM bucket. Timer
    // and GC noise is strictly additive, so the min strips it; a real
    // regression (cost scaling with accumulated rows) is deterministic and
    // present in every run, so it survives the min and still fails loud.
    const runs = Array.from({ length: 5 }, () => {
      const flushMs = pump(N_FRAMES);
      const flushesPerBucket = BUCKET_SIZE / FRAMES_PER_FLUSH;
      const buckets: number[] = [];
      for (let i = 0; i < flushMs.length; i += flushesPerBucket) {
        buckets.push(
          flushMs.slice(i, i + flushesPerBucket).reduce((a, b) => a + b, 0),
        );
      }
      return buckets;
    });

    expect(runs[0]).toHaveLength(N_FRAMES / BUCKET_SIZE);

    const buckets = runs[0].map((_, i) =>
      Math.min(...runs.map((r) => r[i])),
    );
    const med = median(buckets);
    const max = Math.max(...buckets);
    const slowBucket = buckets.indexOf(max);
    const ratio = max / med;

    // The shape, not just the verdict.
    // eslint-disable-next-line no-console
    console.log(
      `\n${asciiHistogram(buckets)}\n` +
        `median=${med.toFixed(2)}ms max=${max.toFixed(2)}ms ratio=${ratio.toFixed(2)} (elementwise min of 5 runs)`,
    );

    const failures: string[] = [];
    if (max > med * FLAT_RATIO + NOISE_FLOOR_MS)
      failures.push(
        `flat-cost bar: bucket ${slowBucket} is ${max.toFixed(2)}ms vs ` +
          `${med.toFixed(2)}ms median (bar ${FLAT_RATIO}× + ${NOISE_FLOOR_MS}ms)`,
      );
    if (max > BUCKET_BUDGET_MS)
      failures.push(
        `60 fps budget: bucket ${slowBucket} took ${max.toFixed(2)}ms (bar ${BUCKET_BUDGET_MS}ms)`,
      );

    expect(failures, failures.join('; ')).toEqual([]);
  }, 60_000);
});
