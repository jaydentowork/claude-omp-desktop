# Perf budget

Locked constraint 2 (issue #8) re-establishes the project's central
performance claim as a Vitest test that fails loud in CI:

> 60 fps transcript at tens of thousands of rows with **flat per-flush cost**.

The test lives at `app/src/main/streaming-cost.test.ts` and runs in the
default `npm test` (`vitest run`) loop.

## The bars

| Bar                          | Threshold                            | Catches                                          |
|------------------------------|--------------------------------------|--------------------------------------------------|
| flat cost                    | `max(bucket) ≤ 1.5 × median + 0.5 ms` | cost scaling with accumulated rows (O(n) leaks)  |
| 60 fps                       | no bucket > 20 ms                    | GC pauses, lock contention, unbounded allocations |

**N** = 50 000 frames. **Bucket size** = 1 000 rows (so each bucket is the
cost of one 1k-row chunk crossing the wire + the renderer's steady-state
work for that chunk). The renderer steady-state work in the test is the
structured clone of the batch envelope + appending frames to a growing rows
array — the real React renderer subsumes both, so a regression that scales
the array shows up as a rising histogram and a failed flat-cost bar.

The +0.5 ms absolute slack on the flat-cost ratio matters: healthy buckets
run ~0.6 ms on the dev baseline below, where scheduler jitter alone is a
few tenths of a ms. A pure 1.5× ratio at that scale flakes. A real
cost-scales-with-rows regression adds *milliseconds* to late buckets, far
beyond ratio + slack.

## Robustness in CI

The measured buckets are the **element-wise minimum across 5 runs**. Timer
and GC noise is strictly additive, so the min strips it; a deterministic
regression (the only thing we actually want to catch) appears in every run
and survives the min. The ASCII histogram printed on every pass lets a
human see the shape, not just the verdict.

## Hardware baseline (dev)

Recorded 2026-08-31.

- CPU: AMD Ryzen 7 9800X3D 8-Core
- RAM: 62 GB
- Node: v25.5.0
- OS: Windows 11 Pro 10.0.26200

Healthy run shape on this box:

- median bucket ≈ 0.55–0.65 ms
- max bucket    ≈ 0.7–1.2 ms
- test wall time ≈ 5 s total (1 warm-up + 5 measured runs, each pumping
  50k frames through `Transport` + mock port + structured clone)

The test runs the same way on Linux/macOS CI runners — the only assumption
is that `performance.now()` is monotonic and `structuredClone` is
available, both of which are guaranteed in Node 17+.

## Acceptance

- `npm test` green on the new file.
- A real regression prints both `flat-cost bar` and `60 fps budget` lines
  with the offending bucket index.
- Dev loop bar unaffected (~1.6 s warm).

## What this test does NOT cover

- Real IPC cost on the Electron wire (only the in-process mock). The
  MessagePortMain path is exercised by `transport.test.ts` and the dev loop.
- Real DOM rendering of the rows array — the test asserts the cost shape
  the renderer must hit; the React side is verified by the renderer tests.
- Latency from main → renderer across processes (only one process in CI).
