import { app, BrowserWindow } from 'electron';
import path from 'node:path';

// Reserved seam: app/src/main/omp-rpc/ — TS decoder module lands with the
// streaming ticket (parity vs assets/fixtures/streaming-capture.ndjson).

// Scaffold literals mirror assets/theme/light.toml:
// app.surfaces.titlebar, app.text.primary, app.layout.titlebar_height.
// Theme compilation replaces these once the theme ticket lands.
const WCO_HEIGHT = 44;
const WCO_BG = '#fcfcfb';
const WCO_FG = '#0b0b0b';

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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
