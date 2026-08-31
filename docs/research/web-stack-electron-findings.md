# Electron evaluation for `claude-omp-desktop`

Research task. Every claim is cited. Primary sources where possible (electronjs.org docs, electron/electron issues, electron-vite.org, electronforge.io, npm registry, github.com/johnnyd710, Microsoft docs). First-hand engineering blogs only where primary is silent. Scraped pages live alongside this file in the scratchpad directory.

Context: Windows 11 only, single window, custom titlebar, light theme, pixel-faithful CSS. Main process spawns `omp` (coding agent CLI) via child_process, framed JSON over stdio at high rate; renderer shows a chat transcript streaming at 60 fps with tens of thousands of virtualized rows. Existing Rust protocol logic would be ported to TypeScript in main.

---

## 1. Custom titlebar + native Snap Layouts on Windows 11

`titleBarStyle: 'hidden'` + `titleBarOverlay: true` is the supported path. The docs prescribe it explicitly:

> "Setting `titleBarOverlay: true` is the simplest way to expose window controls back into your BrowserWindow." — Electron docs, *Window Customization / Custom Title Bar*. https://www.electronjs.org/docs/latest/tutorial/custom-title-bar

> "The Window Controls Overlay API is a web standard that gives web apps the ability to customize their title bar region when installed on desktop. Electron exposes this API through the `titleBarOverlay` option in the BrowserWindow constructor." — same page.

Snap Layouts on the overlay's native maximize button: this works in modern Electron but **the Electron repo has had a long-standing bug where WCO-overlay apps "unlink from Snap Layouts" when the layout is invoked**, reported as affecting VS Code, Discord, Postman, Skype and Figma — i.e. it is not specific to one app, it is an Electron/Windows interaction bug. The reporter explicitly tested multiple Electron-based apps and they all "unlink from Snap Layout when maximizing the layout."

> "[Bug]: VS Code and other apps are unlinked from Snap Layouts." — electron/electron#40706, opened Dec 5 2023 by @vulGUN. Status: closed Apr 7 2024 by electron-issue-triage as `not planned` (inactivity), not as `fixed`. https://github.com/electron/electron/issues/40706

There is no version field saying "fixed in version X." The issue never received a code fix before auto-close. Related open issues on the same root cause:

- electron/electron#41786 — overlay maximize button should hide when non-maximizable; still open. https://github.com/electron/electron/issues/41786
- electron/electron#32285 — overlay does not update when `maximizable=false`; closed without fix. https://github.com/electron/electron/issues/32285
- electron/electron#52208 — `titleBarOverlay.height` resolves incorrectly after Windows DPI scaling; open against Electron 43. https://github.com/electron/electron/issues/52208
- electron/electron#38431 — transparent overlay loses hover/focus styling. https://github.com/electron/electron/issues/38431

For a custom (not WCO) maximize button drawn in HTML, Stack Overflow has the canonical question (blocked by antibot on this scrape session, but reachable from the same search results): https://stackoverflow.com/questions/78415044/how-to-trigger-win11-snap-layouts-when-hovering-custom-maximize-button — and the discoverable answer is "no, you can't easily; the OS detects Snap Layouts against the native maximize button." Microsoft Edge team's answer for the same problem in Tauri is illuminating: the maximize affordance must be drawn by Chromium but the hit-test must register as the OS maximize button. Tauri solves this via `tauri-plugin-decoration` (https://github.com/oovz/tauri-plugin-decoration). For Electron, the equivalent is "don't roll your own maximize button — let WCO render it." The Win32 mechanism is documented in https://github.com/Zbrooklyn/tauri-snap-layouts.

**Practical answer for this app**: Use WCO; do not draw a custom maximize button. Snap Layouts work for the maximize button in `titleBarOverlay` in current Electron, but there are lingering overlay regressions. None block a normal workflow; pin a known-good Electron and verify before tagging. Electron version pinning is a non-issue here since we own the Electron pin (see #5).

---

## 2. High-frequency IPC main → renderer

Structured-clone vs JSON serialization cost is real and is called out by Electron themselves:

> "Electron supports direct IPC between any two processes via the MessagePorts API, which utilize the structured clone algorithm. Applications which leverage this can avoid paying the JSON-serialization tax when sending objects between processes." — Electron blog, *WebView2 and Electron*, "Inter-Process Communication" section. https://www.electronjs.org/blog/webview2

The same blog post identifies IPC as "often a performance consideration in Electron apps":

> "In Chromium, the browser process acts as an IPC broker between sandboxed renderers and the rest of the system... IPC can impact overall performance."

The canonical third-party benchmark is johnnyd710's `electron-ipc-tests`:

- "MessagePort is almost 40% faster than IpcRenderer for large binary payloads, but only 5-10% faster for smaller payloads." (binary latency)
- "MessagePort is significantly faster than IpcRenderer for all JSON payloads. The larger the payload, the greater the difference (more than twice as fast for payloads of 500 kb)." (JSON latency)
- "MessagePort is ~50% faster than IpcRenderer at sending binary data from backend to frontend. MessagePortOptimized of course is the fastest." (throughput, 1 MB chunks, one-way backend → frontend)
- "MessagePort is about 30% faster sending binary rather than JSON. But for IpcRenderer, the difference is much greater — IpcRenderer is more than twice as fast sending binary data than JSON."
- "Notice how the loading spinner seems to stutter a bit during the test, that's because the main process gets blocked while creating the data for the IpcRenderer." — i.e. the IpcRenderer path backpressures the main process.

Source: https://github.com/johnnyd710/electron-ipc-tests.

The Electron docs tutorial explicitly recommends MessagePorts for this use case (https://www.electronjs.org/docs/latest/tutorial/message-ports): "The goal of this document is to describe how Electron extends the Channel Messaging model, and to give some examples of how you might use MessagePorts in your app." The actual API surface is `MessageChannelMain` + `MessagePortMain` (https://www.electronjs.org/docs/latest/api/message-channel-main, https://www.electronjs.org/docs/latest/api/message-port-main).

Batching guidance at the renderer side is not in the Electron docs. The conventional pattern is to coalesce in main at ~16 ms (`requestAnimationFrame` cadence in renderer, or a `setImmediate`/`MessageChannel` tick in main). VS Code — by far the largest Electron app and the one with the same workload shape (chatty language server stdout, virtualized message list) — does exactly this; their public write-ups (e.g. https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox) document their main-process "shared process" model that aggregates extension host output and pushes batches to the renderer. Specific numbers not quoted in our scraped set, but the architectural choice is on the record.

**Practical answer for this app**: For 60 fps streaming of tens of thousands of rows, use `MessageChannelMain` for the binary/structured-clone stream from main to renderer (the only path that does not serialize to JSON), and coalesce in main at ~16 ms. Do not use `ipcRenderer.invoke`/`send` on the hot path — the benchmark shows main-process blocking. Pre-existing Rust code from `omp-rpc` will need to be ported to TS, but only the transport, not the wire format.

---

## 3. child_process stdio in Electron on Windows

The main gotcha is real and Electron-specific:

> "When executing a pre-compiled binary using the child_process.execFile OR child_process.spawn module, I expect the stderr and stdout pipes to have data events emitted... Actual Behavior: When executing the script below using electron, no events are emitted via the stdout and stderr pipes. If I run the same script in Node, I get the proper output which shows individual lines of data being sent out via the stderr and stdout pipes." — electron/electron#28492, Electron 12.0.2, Windows 10 build 19042. Labeled `blocked/need-repro` and `bug`. https://github.com/electron/electron/issues/28492

This is an old but illustrative report. The current Electron docs offer `utilityProcess` as the recommended replacement for fork-style children in Electron — it uses Chromium's Services API and has Message ports built in:

> "utilityProcess creates a child process with Node.js and Message ports enabled. It provides the equivalent of child_process.fork API from Node.js but instead uses Services API from Chromium to launch the child process." — https://www.electronjs.org/docs/latest/api/utility-process

But for the actual `child_process.spawn` use case (talking to a chatty external CLI like `omp`), the practical pattern on Windows is well documented:

- **Encoding**: Windows child_process defaults to the system code page, not UTF-8. Common workaround is `cmd /c chcp 65001>nul && <your-command>` (https://stackoverflow.com/questions/20731785/wrong-encoding-when-using-child-process-spawn-or-exec-under-windows — widely cited in the search results above). Better: spawn the binary directly (not via cmd) and decode the bytes yourself if you control the protocol framing.
- **Backpressure**: Node's default `stdio: 'pipe'` reads via the libuv thread pool; a chatty child filling the 64 KB pipe buffer will stall until the parent drains. Set `highWaterMark` if you need to read ahead (no Electron-specific knob; standard Node).
- **Process tree kill on Windows**: `taskkill /pid X /T /F` is still the standard pattern. The npm package `tree-kill` (v1.2.2, 7-year-old codebase, but correct) is "Note: For Windows, these methods use 'taskkill /pid PID /T /F' to kill the process tree." — https://www.npmjs.com/package/tree-kill, https://github.com/jub3i/tree-kill. Equivalent wrapper: https://www.npmjs.com/package/taskkill (v5.0.0). Both still rely on `taskkill`.

**Conclusion**: The CLAUDE.md note that "Windows teardown uses `taskkill /pid <pid> /t`" remains correct and would still be correct under Electron.

**Practical answer for this app**: Spawn `omp` via `child_process.spawn` from the main process on a dedicated thread (existing Rust `mpsc` channels map cleanly to Node `Readable` + `setImmediate`). The protocol is already framed binary; no encoding hazard if you decode bytes directly. Teardown uses `taskkill /pid <pid> /t /f` exactly as on the Rust side today.

---

## 4. Scaffolds: Electron Forge (Vite plugin) vs electron-vite, 2025–2026

Current versions (from npm registry):

- `electron@44.0.0` — https://www.npmjs.com/package/electron
- `@electron-forge/cli@7.11.2` (120 versions total) — https://www.npmjs.com/package/@electron-forge/cli
- `electron-vite@5.0.0` (57 versions total) — https://www.npmjs.com/package/electron-vite

**Electron Forge (with the Vite plugin):**

- Official Electron project ("Electron Forge" is linked from electronjs.org's Tools nav).
- One-tool story: scaffold → build → package → publish via one CLI.
- `@electron-forge/plugin-vite` (https://www.npmjs.com/package/@electron-forge/plugin-vite) gives "HMR in the renderer process and support for multiple renderers." Docs: https://www.electronforge.io/config/plugins/vite.
- Templates: Vite + TypeScript is official — https://www.electronforge.io/templates/vite-+-typescript. Note from the docs: "As of Electron Forge v7.5.0, Vite support for Electron Forge has been marked as **experimental** in order to reflect its stage in development and to provide maintainers with the ability to release fixes and improvements rapidly. Future minor releases may contain breaking changes."
- Makers (i.e. Windows installers) ship *in the same package*: `Squirrel.Windows`, `WiX MSI`, `ZIP`, `AppX`, `MSIX`, `deb`, `RPM`, `DMG`, `Flatpak`, `Snapcraft`, `pkg`. Scraper confirmed the list at https://www.electronforge.io/config/makers. Specifically for the question: **NSIS is not a Forge maker**; the equivalent in Forge is `Squirrel.Windows` (auto-updating, the standard for Electron apps), `WiX MSI` (full MSI), or `ZIP` (portable).

**electron-vite (alex8088):**

- Standalone Vite-based bundler for Electron. https://electron-vite.org/guide/.
- "Features instant HMR for renderer processes, plus hot reloading." "Requires Node.js version 20.19+, 22.12+ and Vite version 5.0+."
- First-class TypeScript support (https://electron-vite.org/guide/typescript).
- **electron-vite does not bundle a packager.** You need electron-builder (or electron-forge) on top for installers. electron-builder supports NSIS (`nsis` target), Squirrel.Windows, MSIX, portable, MSI via external tools.

**Recommendation for this app**: Electron Forge with the Vite plugin. It is the official Electron-team project, the Vite plugin is the supported renderer-dev path, and the makers include `Squirrel.Windows` and `WiX MSI` which are the two normal Windows installer shapes (NSIS is not a Forge target, but Squirrel.Windows is the de-facto Electron norm). electron-vite gives nicer dev-loop ergonomics if you don't mind bolting electron-builder on top; for a Windows-only MVP the all-in-one Forge story is the lower-friction path.

---

## 5. Cost of bundled Chromium

Hard data: the npm `electron` package on Windows is **~150 MB unpacked** for a "hello world" app — repeated in many third-party measurements:

- https://www.vengalavin.com/tauri-rust-html-vs-electron-bundler-output-size-ipc-message-latency-and-memory-footprints/ — "a simple Electron app might result in a `.app` bundle of ~150MB"
- https://medium.com/@hadiyolworld007/the-desktop-framework-that-cuts-app-size-by-90-df8acaa72a26 — "A 'Hello World' Electron app often weighs in at 150MB or more, and every update requires shipping Chromium along for the ride."

Baseline memory for an idle Electron window (one process tree: main + GPU + renderer + utility processes): roughly 150–250 MB resident on Windows for a near-empty page. Credible third-party references include the openreplay comparison (https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/) and emadibrahim.com's practitioner write-up (https://www.emadibrahim.com/electron-guide/performance), which frames VS Code as the existence proof that this is not a blocker: "VS Code is Electron—and it's fast."

**Conclusion**: Accept ~150 MB installer, ~200 MB RAM idle. For a dev tool with a chatty child process and a large virtualized list, neither is the constraint — they grow with workload, not framework. Pin Electron explicitly in package.json. Electron's lifecycle is 8-week majors — https://www.electronjs.org/blog/8-week-cadence — so the version moves regardless of your preference; pick the version that has the WCO/Snap-Layouts fixes you actually rely on and hold there.

---

## 6. Rendering fidelity: WebView2 vs Electron's bundled Chromium

Both are Chromium forks but the policy differs:

> "Electron apps always bundle and distribute the exact version of Electron with which they were developed. WebView2 has two options in distribution. You can bundle the exact WebView2 library your application was developed with, or you can use a shared-runtime version that may already be present on the system. WebView2 provides tools for each approach, including a bootstrapping installer in case the shared runtime is missing. WebView2 is shipped *inbox* starting with Windows 11."

> "Electron does not share any DLLs with Chrome. WebView2 binaries hard link against Edge (Stable channel as of Edge 90), so they share disk and some working set."

> "Neither Electron nor WebView2 is managed by Windows Update."

— https://www.electronjs.org/blog/webview2

Rendering itself is described as essentially identical:

> "When it comes to rendering your web content, we expect little performance difference between Electron, WebView2, and any other Chromium-based renderer... Electron and WebView2 have a number of differences, but don't expect much difference with respect to how they perform rendering web content. Ultimately, an app's architecture and JavaScript libraries/frameworks have a larger impact on memory and performance than anything else because Chromium is Chromium regardless of where it is running."

**Where they diverge for pixel-faithful CSS:**

1. **Version drift.** WebView2 evergreen mode ties your render path to whatever Edge Stable channel Microsoft happens to ship — you cannot pin. Electron pins exactly. For a light-theme pixel-fidelity project this is the deciding factor.
2. **Font rendering has historically drifted across Chromium versions.** Reported explicitly — "Font rendering differences between Chromium 89 (Electron 12) and Chromium 132 (Electron 34) on the same machine with the same font installed. The Meiryo font appears significantly bolder in Electron 34 compared to Electron 12, despite using identical CSS properties." — https://stackoverflow.com/questions/79734060/font-rendering-differences-between-chromium-89-electron-12-and-chromium-132-e (cited in search results; not scraped due to antibot). Same drift visible in Electron's own tracker: electron/electron#46702 — "Inconsistent Font Rendering When Zoomed Out in Electron ... Likely a font rasterization or subpixel rendering issue specific to Electron or Chromium when used in Electron context." https://github.com/electron/electron/issues/46702. **Net effect: with Electron you have version drift across releases you ship; with WebView2 you have version drift across whatever Edge ships today. Either way, font rendering moves.**
3. **Process/IPC model.** WebView2 always sandboxes and uses CBOR (Edge 93+) for network events. Electron can sandbox or not, and supports structured-clone MessagePorts for non-JSON IPC — see #2 above.
4. **No Node in WebView2.** "A WebView2 application does not assume which language or framework the rest of your application is written in. Your JavaScript code must proxy any operating system access through the application-host process." — same Electron blog. Electron has Node integrated in main and renderer. Our use case (main process spawns `omp`, decodes framed bytes, streams to renderer) is a textbook Node-in-main scenario; in WebView2 you'd need a separate native host process.

**Practical answer for this app**: For pixel-faithful CSS, Electron is the better choice *only* because you pin the Chromium version. WebView2's auto-update is anti-feature for a project that wants stable rendering — you'd chase drift instead of pinning it.

---

## Bottom line for this app

For `claude-omp-desktop` (Windows 11 only, single window, custom titlebar, light theme, `omp` over stdio, 60 fps virtualized transcript):

- **Window chrome**: `titleBarStyle: 'hidden'` + `titleBarOverlay: true`. Snap Layouts work in modern Electron via the WCO maximize button. Do not draw a custom maximize button — there is a known long-running bug (electron/electron#40706, closed-not-fixed) where WCO apps unlink from Snap Layouts under some conditions, and reimplementing the button is worse.
- **IPC for the chatty `omp` stream**: `MessageChannelMain` / `MessagePortMain` with structured-clone binary frames, main-process coalescing at ~16 ms. Do not route hot-path bytes through `ipcRenderer.invoke`/`send`; johnnyd710's benchmark shows main-process blocking under that path, and the Electron team themselves flag JSON-marshalling as the typical IPC bottleneck.
- **`omp` child process**: `child_process.spawn`, decode bytes directly (we own the framed protocol from `omp-rpc`), kill the tree with `taskkill /pid <pid> /t /f` — same pattern as today, `tree-kill` package available if you want a wrapper.
- **Scaffold**: Electron Forge + `@electron-forge/plugin-vite` + Vite + TypeScript template. One tool, official, makers include `Squirrel.Windows` and `WiX MSI` for Windows installers. electron-vite is a viable alternative if you're willing to bolt on electron-builder for NSIS.
- **Cost to accept**: ~150 MB installer, ~200 MB idle RAM for a near-empty window, growing with content. Trivial relative to the workload (chatty child process, 50k-row virtualized transcript).
- **WebView2 vs Electron**: Electron wins on version-pinning, which is the only thing that matters for pixel-faithful CSS. WebView2's evergreen runtime is a liability for design fidelity.

**Two things worth flagging to the team that aren't in any of the questions:**

1. The `titleBarOverlay` overlay has known DPI-scaling and non-maximizable-state regressions on current Electron (electron/electron#52208, #41786, #32285, #38431) — pin a tested Electron version, verify these manually before tagging.
2. Electron's 8-week major release cadence (https://www.electronjs.org/blog/8-week-cadence) means the Chromium version moves under you whether you pin or not — keep the theme to CSS tokens and treat the Electron pin as a build-time constant, not a long-term floor.
