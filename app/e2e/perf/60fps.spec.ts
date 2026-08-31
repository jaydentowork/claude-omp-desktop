// Interactive 60 fps check (issue #19, locked constraint 2).
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
//      measured as rAF callbacks per second in the page.
//   3. Dropped frames (rAF gaps > 1.5 frame periods) stay under 5% of the
//      window.
//
// On top of the verdict the run always writes a Chrome trace
// (`e2e/.output/60fps.trace.json`) — loadable in Perfetto / DevTools
// Performance — so a regression has a profile to diff, not just a number.

import { test, expect, chromium, type Page } from '@playwright/test';
import { CDP_PORT, PERF_ROWS } from '../../playwright.config';

/** fps floor: 60 minus 5 slack, per the issue. */
const FPS_FLOOR = 55;
/** Sampling window inside the stream phase. */
const SAMPLE_MS = 10_000;
/** rAF gap counted as dropped frames when > 1.5 × the 60 Hz period. */
const DROP_GAP_MS = 25;
/** Dropped-frame ceiling over the window: 5% of the 60 Hz budget. */
const MAX_DROP_RATIO = 0.05;
/** Virtualization bound: overscan 12 + a viewport of short rows ≪ 200. */
const MAX_MOUNTED_ROWS = 200;

test('transcript holds 55+ fps with tens of thousands of rows streaming', async () => {
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

    // Phase 2 — sample fps inside the stream phase, with a trace running.
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
      sample = await page.evaluate(async ({ sampleMs, dropGapMs }) => {
        return await new Promise<{ frames: number; elapsedMs: number; dropped: number }>(
          (resolve) => {
            const start = performance.now();
            let last = start;
            let frames = 0;
            let dropped = 0;
            const onFrame = (now: number) => {
              frames += 1;
              const gap = now - last;
              if (gap > dropGapMs) dropped += Math.round(gap / 16.7) - 1;
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
      }, { sampleMs: SAMPLE_MS, dropGapMs: DROP_GAP_MS });
    } finally {
      await browser.stopTracing();
    }

    const fps = (sample.frames / sample.elapsedMs) * 1000;
    const dropRatio = sample.dropped / ((sample.elapsedMs / 1000) * 60);
    // The verdict line CI logs show on every run, pass or fail.
    console.log(
      `[60fps] ${fps.toFixed(1)} fps over ${(sample.elapsedMs / 1000).toFixed(1)} s, ` +
        `${sample.dropped} dropped frames (${(dropRatio * 100).toFixed(1)}% of budget), ` +
        `${mounted} mounted rows — trace: e2e/.output/60fps.trace.json`,
    );

    expect(fps, `measured ${fps.toFixed(1)} fps, ${sample.dropped} dropped`).toBeGreaterThanOrEqual(
      FPS_FLOOR,
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
