// Playwright config for the interactive Electron perf check (issue #19).
//
// No `_electron.launch` here on purpose: Forge has no build-only step, so
// rather than replicate the Vite plugin's build wiring, the test reuses the
// real dev pipeline — `npm start` (Forge + Vite dev server) with a Chromium
// remote-debugging port, and the spec attaches via `connectOverCDP`. The
// whole production stream path (decoder → Transport → MessageChannelMain →
// preload relay → renderer store → virtualized pane) is what's measured.
//
// `OMP_PERF_REPLAY=rows,streamMs` arms the synthetic 60 fps source in main
// (src/main/perf-replay.ts): seed 30k rows, then stream updates for 20 s.
// The spec samples a 10 s fps window inside that stream phase.

import { defineConfig } from '@playwright/test';

export const CDP_PORT = 9315;
export const PERF_ROWS = 30_000;
export const PERF_STREAM_MS = 45_000;

// Occluded/background windows get rAF throttled to ~1 fps, which would fail
// the check spuriously on CI — these Chromium switches keep the renderer at
// full cadence regardless of window visibility.
const CHROMIUM_ARGS = [
  `--remote-debugging-port=${CDP_PORT}`,
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
].join(' ');

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './e2e/.output',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  webServer: {
    // The `--` hands the Chromium switches through Forge to the app argv.
    command: `npx electron-forge start -- ${CHROMIUM_ARGS}`,
    url: `http://127.0.0.1:${CDP_PORT}/json/version`,
    env: { OMP_PERF_REPLAY: `${PERF_ROWS},${PERF_STREAM_MS}` },
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
