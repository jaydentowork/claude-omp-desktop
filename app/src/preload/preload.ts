// Preload: bridges the MessagePort from main into the isolated renderer.
//
// The stream path is exclusively MessageChannelMain + structured clone —
// never send-style ipcRenderer IPC (locked constraint 1; CI greps for it).
//
// A MessagePort can't cross the contextBridge directly, so the bridge
// exposes subscribe(cb): the preload holds the port and forwards each
// batch envelope to renderer callbacks. Batches are already coalesced
// (~16 ms) in main; this is a straight relay.

import { contextBridge, ipcRenderer } from 'electron';

type BatchListener = (batch: unknown) => void;

const listeners = new Set<BatchListener>();
let port: MessagePort | null = null;
// Batches that arrive before the renderer subscribes (port lands on
// did-finish-load, often ahead of React mount). Bounded, drop-oldest —
// same policy as main's Transport.
const backlog: unknown[] = [];
const BACKLOG_CAP = 256;

ipcRenderer.on('omp-port', (event) => {
  port?.close();
  port = event.ports[0] ?? null;
  if (!port) return;
  port.onmessage = (e) => {
    if (listeners.size === 0) {
      if (backlog.length >= BACKLOG_CAP) backlog.shift();
      backlog.push(e.data);
      return;
    }
    for (const cb of listeners) cb(e.data);
  };
  port.start();
});

// Teardown: stop forwarding and close the port when the document goes away
// (window close, reload, navigation). `pagehide` covers the common paths;
// `beforeunload` catches close flows where pagehide doesn't fire in time.
// Idempotent — port.close() on a closed port is a no-op.
function teardown() {
  listeners.clear();
  backlog.length = 0;
  port?.close();
  port = null;
}
window.addEventListener('pagehide', teardown);
window.addEventListener('beforeunload', teardown);

contextBridge.exposeInMainWorld('omp', {
  /** Subscribe to coalesced frame batches. Returns an unsubscribe fn. */
  subscribe(cb: BatchListener): () => void {
    listeners.add(cb);
    while (backlog.length > 0) cb(backlog.shift());
    return () => listeners.delete(cb);
  },
  /** Send a command upstream on the same port (main → omp stdin, later ticket). */
  send(command: unknown): void {
    port?.postMessage(command);
  },
});
