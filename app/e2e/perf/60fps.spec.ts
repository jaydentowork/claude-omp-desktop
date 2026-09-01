// Interactive 60 fps check (issue #19, locked constraint 2; refresh-aware
// bars from issue #29).
//
// Complements the in-process Vitest bench (`src/main/streaming-cost.test.ts`):
// that one asserts flat per-flush cost headlessly; this one measures the
// *on-screen* frame rate of the real renderer — React, the virtualized pane,
// compositor and all — while the synthetic source streams 60 events/s on top
// of a 30k-row backlog.
//
// Harness: `playwright.config.ts` boots the app via `electron-forge start`
// with `OMP_PERF_REPLAY` armed and a CDP port open; this spec attaches with
// `connectOverCDP`. Assertions:
//
//   1. Virtualization holds: mounted row DOM nodes stay bounded while the
//      model holds tens of thousands of rows.
//   2. fps ≥ 55 over a 10 s sampling window (5 fps slack under the 60 bar),
//      AND fps ≥ 0.9 × refreshRate (issue #29: the absolute bar catches
//      catastrophic regressions on any refresh; the relative bar catches
//      sub-60 Hz and >60 Hz displays alike). Whichever is stricter applies.
//   3. Dropped frames (rAF gaps > 1.5 × the local frame period) stay under
//      5% of the window's frame budget.
//
// On top of the verdict the run always writes a Chrome trace
// (`e2e/.output/60fps.trace.json`) — loadable in Perfetto / DevTools
// Performance — so a regression has a profile to diff, not just a number.

import { test, expect, chromium, type Page } from '@playwright/test';
import { CDP_PORT, PERF_ROWS } from '../../playwright.config';

/** Absolute fps floor: 60 minus 5 slack. Catches catastrophic regressions. */
const FPS_FLOOR_ABS = 55;
/** Relative fps floor: 90% of the display refresh rate. (issue #29) */
const FPS_FLOOR_REL_RATIO = 0.9;
/** Sampling window inside the stream phase. */
const SAMPLE_MS = 10_000;
/** Dropped-frame ceiling over the window: 5% of the local frame budget. */
const MAX_DROP_RATIO = 0.05;
/** Virtualization bound: overscan 12 + a viewport of short rows ≪ 200. */
const MAX_MOUNTED_ROWS = 200;

test('transcript holds the fps floor with tens of thousands of rows streaming', async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  try {
    const page = await findAppPage(browser.contexts().flatMap((c) => c.pages()));

    // Phase 1 — wait for the seed to land: the vlist's total size reflects
    // the virtualizer's row count (estimateSize 24 px), so height is a
    // renderer-truth proxy for "the model holds ~PERF_ROWS rows".
    const minSeededHeight = PERF_ROWS * 24 * 0.9;
    await expect
      .poll(async () => vlistHeight(page), { timeout: 60_000 })
      .toBeGreaterThan(minSeededHeight);

    // Virtualization bar: mounted rows stay bounded despite the backlog.
    const mounted = await page.locator('.row-wrap').count();
    expect(mounted, 'mounted row DOM nodes (virtualization bar)').toBeLessThan(
      MAX_MOUNTED_ROWS,
    );

    // Phase 2 — measure the display refresh rate before the load sample:
    // median rAF gap over ~30 quiet-ish frames. Runs on the same rAF clock
    // as the fps sample, so it is right by construction wherever the spec
    // runs (165 Hz dev box, 60 Hz CI, anything else) — no CDP emulation or
    // window.screen API needed. Streaming load can only lengthen gaps, so
    // the median under load still upper-bounds the frame period, i.e. the
    // derived floor errs lenient, never strict.
    const refreshRate = await page.evaluate(async () => {
      const gaps: number[] = [];
      let last = await new Promise<number>(requestAnimationFrame);
      for (let i = 0; i < 30; i++) {
        const now = await new Promise<number>(requestAnimationFrame);
        gaps.push(now - last);
        last = now;
      }
      gaps.sort((a, b) => a - b);
      return 1000 / gaps[Math.floor(gaps.length / 2)];
    });
    // Both bars apply (issue #29): the absolute 55 floor catches
    // catastrophic regressions on any 60 Hz+ display; the relative floor
    // keeps the spec meaningful elsewhere (a 30 Hz display can never hit
    // 55 — the absolute bar only binds where the refresh can support it —
    // and a 165 Hz display coasting at 60 is a real regression the old
    // absolute bar silently passed).
    const relFloor = refreshRate * FPS_FLOOR_REL_RATIO;
    const fpsFloor = refreshRate >= 60 ? Math.max(FPS_FLOOR_ABS, relFloor) : relFloor;
    const framePeriodMs = 1000 / refreshRate;
    // rAF gap counted as dropped frames when > 1.5 × the local frame period.
    const dropGapMs = framePeriodMs * 1.5;

    // Phase 3 — sample fps inside the stream phase, with a trace running.
    await browser.startTracing(page, {
      path: 'e2e/.output/60fps.trace.json',
      screenshots: false,
      categories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'blink.user_timing',
        'v8.execute',
      ],
    });
    let sample: { frames: number; elapsedMs: number; dropped: number };
    try {
      sample = await page.evaluate(async ({ sampleMs, dropGapMs, framePeriodMs }) => {
        return await new Promise<{ frames: number; elapsedMs: number; dropped: number }>(
          (resolve) => {
            const start = performance.now();
            let last = start;
            let frames = 0;
            let dropped = 0;
            const onFrame = (now: number) => {
              frames += 1;
              const gap = now - last;
              if (gap > dropGapMs) dropped += Math.round(gap / framePeriodMs) - 1;
              last = now;
              if (now - start >= sampleMs) {
                resolve({ frames, elapsedMs: now - start, dropped });
                return;
              }
              requestAnimationFrame(onFrame);
            };
            requestAnimationFrame(onFrame);
          },
        );
      }, { sampleMs: SAMPLE_MS, dropGapMs, framePeriodMs });
    } finally {
      await browser.stopTracing();
    }

    const fps = (sample.frames / sample.elapsedMs) * 1000;
    // Drop budget is the local frame budget (refresh × sample duration),
    // so the 5% ceiling tracks whatever display the spec ran on — not 60 Hz.
    const frameBudget = (sample.elapsedMs / 1000) * refreshRate;
    const dropRatio = sample.dropped / frameBudget;
    // The verdict line CI logs show on every run, pass or fail.
    console.log(
      `[60fps] ${fps.toFixed(1)} fps over ${(sample.elapsedMs / 1000).toFixed(1)} s ` +
        `(refresh=${refreshRate.toFixed(1)} Hz, floor=${fpsFloor.toFixed(1)}), ` +
        `${sample.dropped} dropped frames (${(dropRatio * 100).toFixed(1)}% of budget), ` +
        `${mounted} mounted rows — trace: e2e/.output/60fps.trace.json`,
    );

    expect(fps, `measured ${fps.toFixed(1)} fps, ${sample.dropped} dropped`).toBeGreaterThanOrEqual(
      fpsFloor,
    );
    expect(dropRatio, `${sample.dropped} dropped frames over ${SAMPLE_MS} ms`).toBeLessThanOrEqual(
      MAX_DROP_RATIO,
    );
  } finally {
    // Detach only — the app process belongs to the webServer teardown.
    await browser.close();
  }
});

async function vlistHeight(page: Page): Promise<number> {
  return page
    .locator('.transcript-vlist')
    .evaluate((el) => el.getBoundingClientRect().height)
    .catch(() => 0);
}

/** The CDP endpoint exposes every page (incl. devtools); pick the app root. */
async function findAppPage(pages: Page[]): Promise<Page> {
  for (const p of pages) {
    if (await p.locator('#root').count().then((n) => n > 0).catch(() => false)) return p;
  }
  throw new Error(`app page not found among ${pages.length} CDP pages`);
}
