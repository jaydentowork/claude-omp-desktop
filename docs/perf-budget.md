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

| Bar            | Threshold                                                | Catches                                      |
|----------------|----------------------------------------------------------|----------------------------------------------|
| virtualization | mounted `.row-wrap` nodes < 200 at 30k rows              | dropping virtualisation (full-list render)   |
| fps floor      | refresh-aware (issue #29): see below                      | anything that stalls the frame clock         |
| dropped frames | rAF gaps > 1.5 × local frame period, < 5% of local budget | jank bursts a mean fps number would average out |

**Refresh-aware floor (issue #29).** rAF follows the display refresh rate, so a single absolute threshold is meaningless on anything but 60 Hz. The spec measures refresh before the load sample (median rAF gap over ~30 quiet frames on the same rAF clock as the fps sample — right by construction wherever the spec runs, no CDP emulation needed) and applies **both** bars:

- **Absolute** `fps ≥ 55` — only binds when `refreshRate ≥ 60` (catches catastrophic regressions on a 60 Hz+ display without weakening the relative bar on sub-60 Hz hardware).
- **Relative** `fps ≥ 0.9 × refreshRate` — keeps the spec meaningful on sub-60 Hz (a 30 Hz display cannot hit 55; the relative floor says "≥ 27") and on >60 Hz displays (a 165 Hz display coasting at 60 fps is a real regression the old absolute bar silently passed).

The drop gap and drop budget are scaled to the local frame period (e.g. 16.7 ms / 6.1 ms on 60 / 165 Hz), so the dropped-frame ceiling tracks whatever display the spec ran on. Streaming load can only lengthen rAF gaps, so the median under load still upper-bounds the frame period — the derived floor errs lenient, never strict.

The verdict line (`[60fps] N fps over T s (refresh=R Hz, floor=F), D dropped frames (X% of budget), M mounted rows`) prints on every run, pass or fail, so the threshold that fired is in the CI log.

fps is measured as `requestAnimationFrame` callbacks per second inside the
page — the compositor's own frame clock, so React render cost, layout and
paint are all inside the measurement. The run always writes a Chrome trace
to `app/e2e/.output/60fps.trace.json` (load in Perfetto or the DevTools
Performance tab) so a regression has a profile to diff, not just a number.

Background-throttling Chromium switches
(`--disable-background-timer-throttling` etc., see
`app/playwright.config.ts`) keep the occluded/headless CI window at full
rAF cadence — without them a hidden window idles at ~1 fps and fails
spuriously.

Verified regression sensitivity: replacing `getVirtualItems()` with a
render-every-row map fails the run loudly (the seed phase itself times out
under the O(rows) render, before the fps bar is even reached).

Baseline on the dev box below: ~164 fps against a measured 165 Hz refresh
(floor 148.5 from the relative bar), 0 dropped frames, 50 mounted rows,
whole spec ~24 s. Under issue #29's bars the same run is now held to 90% of
its own refresh rather than a 55 bar it could never meaningfully fail.
