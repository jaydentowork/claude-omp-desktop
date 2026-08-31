# Tauri v2 — Windows Viability Research (Aug 2026)

App profile: Windows-11-only desktop client. Single window, custom titlebar / `decorations: false`, light theme. Child process `omp` emits framed JSON over stdio at high rate. UI is a chat transcript streaming at ~60fps with tens of thousands of rows. Existing Rust crate `omp-rpc` is std-only and headlessly testable.

---

## 1. Tauri v2 maturity on Windows / WebView2 (2025-2026)

**Current stable**: `tauri` 2.11.5 released **Jul 1, 2026**. The 2.11.x line is the active stable train (2.11.5 → 2.11.4 → 2.11.3 → 2.11.2 → 2.11.1 → 2.11.0, the last a feature release dated Apr 30, 2026). [https://v2.tauri.app/release/tauri/]

**Footprint on Windows**: runtime is WebView2 (Edge / Chromium-based). "On Windows 11 the runtime is preinstalled, on older versions Tauri bundles an installer." [https://v2.tauri.app/reference/webview-versions/] Apps are usually a few MB — main draw vs Electron.

**Notable Windows-specific bug activity**:
- **`#15569` — Progressive resize degradation on Windows with `decorations: false`** (opened Jun 20, 2026; root cause: `SetWindowRgn` in `undecorated_resizing.rs`; web content visibly lags frame after ~30s of drag-resize). **Already fixed** in PR `#15614`. [https://github.com/tauri-apps/tauri/issues/15569]
- **`#11787` — `event.emit_to` freezes main window** when used between webview windows at high rate. Multi-window event piping is not zero-cost on Windows. [https://github.com/tauri-apps/tauri/issues/11787]
- **`#6322` — Resize perf gap vs raw Wry** (open since 2023, perf-related). [https://github.com/tauri-apps/tauri/issues/6322]

**Bottom line**: v2 is production-ready on Windows; Windows has the heaviest bug backlog of the three targets but it is actively maintained. For a Windows-only app, the bug surface is bounded and well-known.

---

## 2. Custom titlebar + Windows11 Snap Layouts

**The gotcha (not a bug, an architectural fact)**: with `decorations: false`, the Snap Layouts flyout is silently disabled. Windows only shows Snap Layouts to a window that answers `WM_NCHITTEST` with `HTMAXBUTTON`, and in a Tauri app the **WebView2 child window** (`Chrome_RenderWidgetHostHWND`) intercepts the hit-test before your window procedure is ever consulted. No HTML/CSS/JS can fix it. [https://github.com/Zbrooklyn/tauri-snap-layouts] [https://github.com/rust-windowing/winit/issues/3884] [https://github.com/tauri-apps/tauri/issues/4531]

**Tracking issue**: `tauri-apps/tauri#4531` is labelled `status: upstream`. That means Tauri's first-class API is blocked on winit/tao — **not** that the feature is impossible. Five independent plugins have converged on the identical Win32 workaround.

**The workaround (works today)**: A small transparent native child window sits over your HTML maximize button; its window proc returns `HTMAXBUTTON` unconditionally. It never paints, your design shows through, but it owns the mouse in that rectangle. Required style set: `WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_OVERLAPPED`, NULL_BRUSH background, `SWP_ASYNCWINDOWPOS | SWP_SHOWWINDOW`. Do **not** use `WS_EX_LAYERED` — that costs you the hit-test. [https://github.com/Zbrooklyn/tauri-snap-layouts]

**Plugins that ship this**:
- **`tauri-plugin-frame`** — used by the Zbrooklyn templates; explicit `.button_width(46)` / `.titlebar_height(32)` must match CSS; provides click + hover event hooks (`tauri-frame://snap/click`, `…/mouseenter`, `…/mouseleave`). [https://github.com/clarifei/tauri-plugin-frame]
- **`tauri-plugin-decorum`** — opinionated titlebar lib that retains Snap Layouts by default. [https://github.com/clearlysid/tauri-plugin-decorum]
- **`tauri-plugin-snap-layout`** — focused overlay only. [https://github.com/Hyph-M/tauri-plugin-snap-layout]
- **`tauri-plugin-window-controls`** — insd47. [https://github.com/insd47/tauri-plugin-window-controls]
- `tauri-plugin-decoration` — older, superseded.

**Microsoft's own constraint**: `minWidth` must be ≤ ~500 (ideally ≤ 330) for the flyout to actually snap. Larger `minWidth` → flyout appears but the window won't snap into zones. Plugin presets follow this.

**Rounded corners** on Win11: call `DwmSetWindowAttribute` with `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`. Per MS docs: *"a hint to the system and does not guarantee rounding"*; windows with per-pixel alpha or window regions cannot be rounded. Custom radius (14px etc.) is not a supported API on Win11 — Electron's `roundedCorners` is a boolean only since v34.3.0.

**Verification gotcha**: `PrintWindow` cannot capture the Snap flyout — the flyout is a separate OS window, screenshot-based tests produce confident false failures. The Zbrooklyn templates ship `verify.ps1` that asserts against the OS via `WM_NCHITTEST`; the only way to screenshot a rounded window with alpha is `Windows.Graphics.Capture`.

---

## 3. IPC throughput, Rust → webview (the load-bearing question for this app)

**Hard fact from Tauri's own docs**: the event system is **explicitly not designed for high-throughput / low-latency streaming**.

> "The event system was designed for situations where small amounts of data need to be streamed or you need to implement a multi consumer multi producer pattern (e.g. push notification system). The event system is not designed for low latency or high throughput situations. See the channels section for the implementation optimized for streaming data." [https://v2.tauri.app/develop/calling-frontend/]

Also: "Under the hood it directly evaluates JavaScript code so it might not be suitable to sending a large amount of data." [https://v2.tauri.app/develop/calling-frontend/]

> "event payloads are always JSON strings making them not suitable for bigger messages" — official docs. [https://v2.tauri.app/develop/calling-frontend/]

**`tauri::ipc::Channel<T>` is the answer**, and it's officially the recommended path for streaming:
> "Channels are designed to be fast and deliver ordered data. They are used internally for streaming operations such as download progress, child process output and WebSocket messages." [https://v2.tauri.app/develop/calling-frontend/]

**Channel mechanism** (per `tauri/src/ipc/channel.rs`, [https://deepwiki.com/tauri-apps/tauri/4.2-channel-api-for-streaming]):
- Frontend creates a `new Channel<T>()` and passes it as an arg when invoking a `#[tauri::command]`.
- The IPC layer serializes the channel ref with prefix `__CHANNEL__:` and registers a JS callback via `transformCallback`.
- Rust side holds `Channel<TSend: Serialize>`; `channel.send(data)` triggers the frontend callback.
- Transport: `webview.eval` for normal payloads, **a fetch-based data queue for large payloads** ([`channel.rs:158-182`]). This is the critical path for "small JSON at hundreds of events/sec" — messages can be sent many times; each lands as an async callback in JS.

**Ordering**: channels preserve order; events do not (async listeners can reorder at high rate — docs warn about this).

**Streaming example Tauri ships**: `examples/streaming/main.rs` ([https://github.com/tauri-apps/tauri/blob/dev/examples/streaming/main.rs]) demonstrates the `Channel<T>` + `#[tauri::command]` + multi-step streaming pattern that the official updater plugin now uses internally for download progress reporting. [https://v2.tauri.app/plugin/updater/]

**Performance discussion in the wild**: [https://github.com/orgs/tauri-apps/discussions/5690] "IPC Improvements" — Tauri team discusses `ipc.postMessage` vs custom protocol paths; on Windows it's `postMessage`-based. The discussion makes clear events are a thin wrapper over `eval()`, hence the perf ceiling.

**Conclusion for our workload**: `omp` emits framed JSON on stdio → decode in `omp-rpc` → push `ChatEvent` into a Rust `Vec<Arc<TranscriptionRow>>` → emit via `Channel<ChatEvent>` to the frontend → frontend incrementally appends to virtual-list at 60fps. This is exactly the pattern Channels were designed for. **Do not use `app.emit(...)` for transcript streaming.**

---

## 4. Child process management

Spawning/killing a process tree from Tauri's Rust core is plain `tokio::process` / `std::process` underneath — no Tauri-specific obstacle. Tauri's **`tauri-plugin-shell`** wraps it with permissions and bundles binaries via the `externalBin` config. [https://v2.tauri.app/develop/sidecar/]

**What the sidecar feature actually is**: a *packaging* convention, not a runtime feature. You declare binaries in `tauri.conf.json -> bundle.externalBin`, name them with the target-triple suffix (`my-sidecar-x86_64-pc-windows-msvc.exe`), and `tauri build` ships them next to your exe. At runtime you call `app.shell().sidecar("my-sidecar")` (Rust) or `Command.sidecar("my-sidecar")` (JS), which spawns the bundled binary. [https://v2.tauri.app/develop/sidecar/]

**Do you need it for `omp` on PATH?** No. Sidecar is for bundling a CLI *into the installer*. If `omp` is installed by the user (or by your installer separately), spawn it via `tokio::process::Command::new("omp")` directly — no plugin needed. Sidecar gives you:
1. Binary ships with the app (no PATH dependency).
2. Capability/permission gating so the frontend can also spawn it.
3. Per-platform target-triple routing automatically.

**Tear-down on Windows**: `taskkill /pid <pid> /t /f` for the process tree (your existing pattern works identically). Tauri's shell plugin's `Command::kill()` will signal the child; for grandchildren you still need `taskkill /t` from Rust.

---

## 5. Packaging + updater on Windows

**What `tauri build` produces on Windows**:
- **NSIS** installer (`-setup.exe`) — works on Win 7+, cross-compilable from Linux/macOS (with caveats), NSIS 3.x required.
- **MSI** installer (`.msi`) — produced via WiX Toolset v3; **MSI can only be created on Windows** (WiX is Windows-only). Requires the `VBSCRIPT` Windows optional feature (on by default).
- Both formats supported simultaneously by setting `targets: "all"`. [https://v2.tauri.app/distribute/windows-installer/]

**WebView2 bootstrap strategies** ([https://v2.tauri.app/distribute/windows-installer/]):

| Mode | Adds size | Internet needed | Notes |
|------|-----------|-----------------|-------|
| `downloadBootstrapper` (default) | 0 MB | Yes | Smallest installer |
| `embedBootstrapper` | ~1.8 MB | Yes | Better Win 7 MSI support |
| `offlineInstaller` | ~127 MB | No | Air-gapped installs |
| `fixedVersion` | ~180 MB | No | **Pins WebView2 — reproducible rendering of the 60fps transcript** |

For Win11-only: WebView2 is preinstalled (Oct 2018+ Win 10 too), so default `downloadBootstrapper` is fine and the install size stays tiny.

**Updater plugin (`tauri-plugin-updater`)** ([https://v2.tauri.app/plugin/updater/]):
- **Signatures are mandatory** ("This cannot be disabled"). Two keys generated via `tauri signer generate`. Private key in `TAURI_SIGNING_PRIVATE_KEY` env var at build time.
- **Two server shapes supported**:
  1. **Static JSON** on any HTTPS endpoint (GitHub Releases, S3, etc.) — `version` + `platforms.{OS-ARCH}.{url,signature}` per platform. Tauri's official `tauri-action` generates this for GitHub Releases.
  2. **Dynamic update server** — your endpoint sees `{{current_version}}`, `{{target}}`, `{{arch}}` in the URL, returns JSON. CrabNebula Cloud is the official partner offering for this.
- On Windows install: `installMode` controls UX (`passive` default = progress bar; `basicUi` = interactive; `quiet` = silent, requires user-wide install). [https://v2.tauri.app/plugin/updater/]
- **Caveat**: *"On Windows the application is automatically exited when the install step is executed due to a limitation of Windows installers."* [https://v2.tauri.app/plugin/updater/]
- **Windows code signing**: required to avoid SmartScreen "unknown publisher" prompts. OV certs (pre-June 2023 rules apply per docs), Azure Key Vault, EV certs all supported. Tauri-Action on GitHub can sign in CI. [https://v2.tauri.app/distribute/sign/windows/]
- **MSIX story**: not natively a first-class Tauri target. Microsoft Store distribution goes through a manual process. No special MSIX packaging beyond MSI.

---

## 6. create-tauri-app + dev loop

**Scaffolding**: `npm create tauri-app@latest` (or `cargo install create-tauri-app`). Interactive prompts pick project name, frontend language, package manager, framework. Officially supported templates: vanilla, Vue, Svelte, React, SolidJS, Angular, Preact, Yew, Leptos, Sycamore. [https://v2.tauri.app/start/create-project/]

**React + TS + Vite** is a first-class path. The scaffold produces:
- `src/` — Vite + React + TS frontend.
- `src-tauri/` — Rust crate with `tauri.conf.json`, `Cargo.toml`, `build.rs`, `src/lib.rs`, `src/main.rs`, `capabilities/`.
- `package.json` with `tauri` scripts: `dev`, `build`.

**Dev loop**:
- `npm run tauri dev` (or `cargo tauri dev`) starts Vite's HMR for the frontend in the same process as a debug build of the Rust core, embedded in a Tauri window. Frontend edits reload via Vite; Rust edits trigger rebuild + relaunch.
- Frontend dev port = Vite (default 1420); the Tauri window loads from it in dev, from a custom `tauri://` protocol in release.
- **Known dev-only win**: `wry` on Windows uses the system WebView2 in dev too, so dev and release render paths are identical — no surprise drift.
- Release builds via `cargo tauri build` (or `npm run tauri build`). Windows installers land in `target/<triple>/release/bundle/{nsis,msi}/`.

**Bundle size baseline on Windows**: a "Hello World" Tauri app is roughly 2-5 MB (vs Electron ~150 MB). For our app, dominated by the WebView2 runtime (system) + small Rust binary.

---

## 7. WebView2 evergreen runtime — known pain

**Tauri cannot pin WebView2 by default**; the system runtime auto-updates. Microsoft Edge WebView2 docs: *"By default, WebView2 is evergreen and receives automatic updates."* [https://developer.microsoft.com/en-us/microsoft-edge/webview2/]

**Known rendering regressions**: yes — and they hit Tauri users directly because Tauri embeds the same WebView2.
- **MicrosoftEdge/WebView2Feedback#5642** — *"Regression (~2026-07-02 runtime update): embedded WebView2 …"*. Stable Runtime 149..4022.98, regression window 2026-06-30 → 2026-07-02. The reporter's app was demonstrably sharp on the same code before the runtime updated. This is a Tauri 2 / wry 0.55.1 / `CreateCoreWebView2Controller` app — a real production example of an evergreen regression. [https://github.com/MicrosoftEdge/WebView2Feedback/issues/5642]
- **MicrosoftEdge/WebView2Feedback#5685** — DevTools/CDP endpoint global regression starting 2026-08-30. Affects Evergreen *and* Fixed runtimes. [https://github.com/MicrosoftEdge/WebView2Feedback/issues/5685]

**Cost of pinning (fixedVersion)**: ~180 MB added to the installer (table above), zero internet required, no auto-patches (you own WebView2 security updates yourself). [https://v2.tauri.app/distribute/windows-installer/]

**Recommendation for our app**: ship with default evergreen (WebView2 is preinstalled on Win 11; default downloadBootstrapper adds 0 MB). The 60fps transcript UI is sensitive to compositor/regression changes; if a user reports visual breakage after a Windows update, document the `fixedVersion` opt-out escape hatch in your README — but don't pay the 180 MB tax for the median user.

---

## Bottom line for this app

**Tauri v2 is the right answer.** The combination that matters most for our workload:
- **Existing `omp-rpc` crate drops into Tauri's Rust core verbatim** (it's already std-only, headlessly testable) — that's the whole point of the move from raw GPUI.
- **Streaming chat transcript at 60fps / tens of thousands of rows is exactly the use case `tauri::ipc::Channel<T>` was designed for.** `app.emit(...)` will not work; use `Channel<ChatEvent>` passed to a `#[tauri::command]` and send from the `omp-rpc` read loop. Do not skip this — it's the difference between 5 fps and 60 fps.
- **`omp` as a child process**: spawn from Rust core via plain `tokio::process::Command` (no `tauri-plugin-shell` needed if you don't want frontend to spawn it). Use `taskkill /t /f` on teardown, identical to current. **Do not bundle `omp` as a sidecar** unless you want the installer to ship it — the existing `omp` on PATH assumption keeps the install small.
- **Custom titlebar with Snap Layouts** requires either `tauri-plugin-frame` (~380 LOC of Win32 overlay technique) or rolling the same trick yourself. Non-negotiable for Win 11 polish; pick a plugin and don't try to invent your own overlay without reading the trap list in [Zbrooklyn/tauri-snap-layouts README](https://github.com/Zbrooklyn/tauri-snap-layouts).
- **Updater**: ship the `tauri-plugin-updater` from day1 (signing keys, static JSON on GitHub Releases). Don't ship unsigned installers — SmartScreen will hurt adoption. Add to issue map now; the cert-purchase and Key Vault wiring are long-lead.
- **MSIX**: not relevant. MSI + NSIS covers it; stay with that.
- **Pinned WebView2 (`fixedVersion`)**: don't ship by default. Document it as a per-user escape hatch for the rare evergreen regression (see WebView2Feedback#5642 above).
- **Streaming perf benchmark**: port the existing `tests/streaming-cost.rs` to a Tauri Channel-based harness as well — keep the project's central performance claim tested in `cargo test`, not just by eye. The new ceiling to add to the benchmark: end-to-end latency from `omp` stdout byte to DOM row, not just per-flush sizing cost.

**Risk** ranked: (a) Snap Layouts without a plugin — high pain, easy mitigation; (b) Windows-specific bugs in current stable — low (small app, single window); (c) WebView2 evergreen regression — low (rare, documented, fixable with fixedVersion); (d) Tauri's IPC if you reach for `emit` instead of `Channel` — **catastrophic** for our 60fps claim.