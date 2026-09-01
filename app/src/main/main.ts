import { app, BrowserWindow, MessageChannelMain } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Transport } from './transport';
import { OmpPump } from './omp-pump';
import { FrameDecoder } from './omp-rpc';
import { PerfReplay, parsePerfReplayEnv } from './perf-replay';

// Scaffold literals mirror assets/theme/light.toml:
// app.surfaces.titlebar, app.text.primary, app.layout.titlebar_height.
// Theme compilation replaces these once the theme ticket lands.
const WCO_HEIGHT = 44;
const WCO_BG = '#fcfcfb';
const WCO_FG = '#0b0b0b';

/** One transport per window; replaced on reload. */
let transport: Transport | null = null;
/** One omp child per window; taskkill-tree'd on close. */
let pump: OmpPump | null = null;

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // Transcript hard floor (docs/window-shell.md §3): 360 px pane min-width.
    minWidth: 360,
    // Window Controls Overlay: native caption buttons over web content.
    // Never draw a custom maximize button — Snap Layouts only attach to the
    // native WCO button.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: WCO_BG,
      symbolColor: WCO_FG,
      height: WCO_HEIGHT,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Hot IPC transport: ports cross via postMessage('omp-port', ...). The
  // child pump lands with the omp-spawn ticket; until then
  // `transport.ingest` is unused but the wiring is live end-to-end.
  // Fresh channel per load — a transferred port2 is neutered, so dev-loop
  // reloads must re-mint the pair and rebind port1.
  transport = new Transport();
  // Replay timer is local to this window; close clears it even mid-capture.
  let replayTimer: ReturnType<typeof setInterval> | null = null;
  // Synthetic perf source is likewise per-window; disposed on close.
  let perfReplay: PerfReplay | null = null;
  const perfOpts = parsePerfReplayEnv(process.env.OMP_PERF_REPLAY);
  if (perfOpts !== null) {
    // Synthetic 60 fps source for the Playwright perf check (issue #19):
    // seeds tens of thousands of rows, then streams updates at 60 events/s.
    // Run: OMP_PERF_REPLAY=30000,10000 npm start
    // Construction is enough — start is deferred to did-finish-load so the
    // Transport has a renderer port attached before frames begin queueing
    // (the pending cap of 256 would otherwise drop-oldest during load).
    perfReplay = new PerfReplay(transport, perfOpts);
  } else if (process.env.OMP_REPLAY_FIXTURE) {
    // Spawn-less replay for dev (issue #20 acceptance): stream the recorded
    // capture through the real decoder + transport at ~60 events/s so the
    // pane visibly streams — no live `omp` required.
    // Run: OMP_REPLAY_FIXTURE=../assets/fixtures/streaming-capture.ndjson npm start
    const fixture = readFileSync(
      path.resolve(process.env.OMP_REPLAY_FIXTURE),
      'utf8',
    );
    const decoder = new FrameDecoder();
    const lines = fixture.split('\n').filter((l) => l.trim().length > 0);
    let i = 0;
    replayTimer = setInterval(() => {
      if (i >= lines.length) {
        if (replayTimer !== null) {
          clearInterval(replayTimer);
          replayTimer = null;
        }
        return;
      }
      const frame = decoder.feedLine(lines[i++]);
      if (frame === null) return;
      if (frame.kind === 'ready') transport?.ingest({ kind: 'ready', payload: frame.ready });
      else if (frame.kind === 'response') transport?.ingest({ kind: 'response', payload: frame.response });
      else transport?.ingest({ kind: frame.tag || 'unknown', payload: frame.raw });
    }, 16);
  } else {
    // omp child: source of the frame stream. Session management (picking a
    // cwd per session, restart on switch) is a later ticket — for now one
    // child in the app cwd, overridable for dev via OMP_PATH / OMP_CWD.
    pump = new OmpPump({
      ompPath: process.env.OMP_PATH ?? 'omp',
      cwd: process.env.OMP_CWD ?? process.cwd(),
      transport,
    });
    pump.start();
    // Upstream path: renderer commands (already JSON objects) become NDJSON
    // lines on the child's stdin. Replay modes leave onCommand unset — a
    // command sent with no live child is a no-op, same as a dead child.
    transport.onCommand = (command) => {
      pump?.send(JSON.stringify(command));
    };
  }
  mainWindow.webContents.on('did-finish-load', () => {
    const channel = new MessageChannelMain();
    transport?.attach(channel.port1);
    // Upstream direction of the same channel: preload's `omp.send(command)`
    // posts the command envelope back on this port; forward it to the child's
    // stdin as one NDJSON line (issue #23 — composer submit path).
    // `start()` is required on the main-side port too — MessagePortMain
    // queues 'message' events until then, mirroring the renderer-side
    // `preload.ts:35` call.
    channel.port1.on('message', (e) => {
      const command = e.data;
      if (command === null || typeof command !== 'object') return;
      pump?.send(JSON.stringify(command));
    });
    channel.port1.start();
    mainWindow.webContents.postMessage('omp-port', null, [channel.port2]);
    perfReplay?.start();
  });
  mainWindow.on('closed', () => {
    if (replayTimer !== null) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
    perfReplay?.dispose();
    perfReplay = null;
    // taskkill /t /f — child.kill() would orphan LSP/extension grandchildren.
    pump?.dispose();
    pump = null;
    transport?.dispose();
    transport = null;
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
