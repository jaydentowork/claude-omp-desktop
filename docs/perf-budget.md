# Perf budget

Locked constraint 2 (issue #8) re-establishes the project's central
performance claim as a Vitest test that fails loud in CI:

> 60 fps transcript at tens of thousands of rows with **flat per-flush cost**.

The test lives at `app/src/main/streaming-cost.test.ts` and runs in the
default `npm test` (`vitest run`) loop. The interactive on-screen half of
the claim (issue #19) is the Playwright check below.

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

All three gaps are what the Playwright interactive check covers.

## The Playwright interactive bar (issue #19)

`app/e2e/perf/60fps.spec.ts`, run via `npm run e2e`. Boots the real app
(`electron-forge start` with a CDP port; the spec attaches over
`connectOverCDP`) with the synthetic 60 fps source armed
(`OMP_PERF_REPLAY=30000,45000`, `app/src/main/perf-replay.ts`): **seed**
30 000 settled rows through the live decoder→Transport→MessageChannelMain→
preload→store→virtualized-pane pipeline, then **stream** `message_update`
snapshots at 60 events/s for 45 s against that backlog.

| Bar            | Threshold                                   | Catches                                      |
|----------------|---------------------------------------------|----------------------------------------------|
| virtualization | mounted `.row-wrap` nodes < 200 at 30k rows | dropping virtualisation (full-list render)   |
| fps floor      | ≥ 55 fps over a 10 s window in-stream       | anything that stalls the frame clock         |
| dropped frames | rAF gaps > 25 ms total < 5% of 60 Hz budget | jank bursts a mean fps number would average out |

fps is measured as `requestAnimationFrame` callbacks per second inside the
page — the compositor's own frame clock, so React render cost, layout and
paint are all inside the measurement. The run always writes a Chrome trace
to `app/e2e/.output/60fps.trace.json` (load in Perfetto or the DevTools
Performance tab) so a regression has a profile to diff, not just a number.
The verdict line (`[60fps] N fps, D dropped, M mounted rows`) prints on
every run, pass or fail.

Background-throttling Chromium switches
(`--disable-background-timer-throttling` etc., see
`app/playwright.config.ts`) keep the occluded/headless CI window at full
rAF cadence — without them a hidden window idles at ~1 fps and fails
spuriously.

Verified regression sensitivity: replacing `getVirtualItems()` with a
render-every-row map fails the run loudly (the seed phase itself times out
under the O(rows) render, before the fps bar is even reached).

Baseline on the dev box below: ~164 fps (165 Hz display — rAF follows the
refresh rate, hence a floor well under the healthy value), 0 dropped
frames, 50 mounted rows, whole spec ~24 s.
