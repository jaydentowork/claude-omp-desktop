# Web stack choice — Tauri v2 vs Electron

**Author:** research synthesis (taekwonnie), 2026-08-31
**Scope:** Windows-11-only MVP rebuild of `claude-omp-desktop` on a web-based renderer.
**Method:** three parallel primary-source research passes (Tauri/Electron/renderer). Raw findings in `web-stack-{tauri,electron,renderer}-findings.md` next to this file; per-claim citations inline in those files.

## Bottom line

**Electron.** Same-reason Tauri loses: WebView2's *evergreen* runtime is anti-feature for pixel-faithful CSS, and Tauri cannot pin the runtime without paying ~180 MB. Electron pins Chromium per installer and owns the version drift instead of inheriting it. Everything else (60 fps transcript, child-process `omp`, custom titlebar, scaffold, cost) is a tie or a wash; the fidelity question is decisive.

Renderer stack is the same either way: React + TS, `@tanstack/react-virtual` (chat primitives: `anchorTo:'end'`, `followOnAppend`, `scrollEndThreshold: 4`, `directDomUpdates`), `streamdown` (block-memoized GFM via `remend`), `shiki` via `@streamdown/code` (lazy-on-complete).

## Comparison

| Question | Tauri v2 (2.11.5) | Electron (44.0.0) | Winner |
|---|---|---|---|
| `omp-rpc` reuse | Drops in verbatim — already std-only, headlessly testable | Must port frame codec to TS in main | Tauri |
| Stream hot path | `tauri::ipc::Channel<T>` is the official streaming primitive (designed for this) | `MessageChannelMain` + structured-clone + ~16 ms coalescing in main | Tauri (one-liner) vs Electron (more knobs but more code) |
| Window chrome + Snap Layouts | `decorations:false` *silently disables* Snap Layouts; WebView2 child window intercepts `WM_NCHITTEST`. Fix: native transparent overlay window returning `HTMAXBUTTON` — `tauri-plugin-frame` or `tauri-plugin-snap-layout` ship it | `titleBarStyle:'hidden' + titleBarOverlay:true`; WCO maximize button keeps Snap Layouts. Open bugs (#40706 unlink, #52208 DPI) but pinned-version mitigates | Electron |
| `omp` child process | Plain `tokio::process` in Rust core; `taskkill /t /f` unchanged | `child_process.spawn` in main; `taskkill /t /f` unchanged. Use `tree-kill` pkg if you want a wrapper | Tie |
| Scaffold | `npm create tauri-app@latest` (React+TS+Vite first-class); dev loop = Vite HMR + Rust rebuild | **Electron Forge 7.11.2 + `@electron-forge/plugin-vite`** + Vite + TS template. One tool, makers include `Squirrel.Windows` / `WiX MSI` / `ZIP`. NSIS is not a Forge maker; Squirrel is the Electron norm | Electron (one tool) |
| Packaging | NSIS + MSI via `cargo tauri build`. Updater: `tauri-plugin-updater`, **signing keys mandatory**, two server shapes (static JSON on GH Releases or dynamic). SmartScreen = need code-sign cert | Squirrel.Windows / WiX MSI / ZIP via Forge. Auto-update via `electron-updater`; same signing story | Tie |
| Rendering fidelity | WebView2 evergreen = cannot pin; known regressions (WebView2Feedback#5642 ~2026-07-02) can ship silently. `fixedVersion` opt-in costs ~180 MB | Pins exact Chromium per installer. Version drift across releases you ship, but **you own when** | **Electron** |
| Install size / RAM | "Hello world" ~2–5 MB; WebView2 preinstalled on Win 11 → 0 MB bootstrap | "Hello world" ~150 MB unpacked, ~150–250 MB RAM idle for one window | Tauri |
| First-class Windows | Yes — but has the heaviest bug backlog of the three targets | Yes; 8-week majors, own the pin | Tie |
| Streaming perf claim | Channel-based pattern ships from day 1; existing `tests/streaming-cost.rs` re-aims at end-to-end latency | Same end-to-end goal; structured-clone + coalesce in main, **verify in `cargo test` equivalent** | Tie |

## Rejected alternatives

- **Tauri v2** — evergreen WebView2 drift is the wrong default for pixel-faithful CSS, and the `omp-rpc` reuse win is real but does not outweigh the Snap Layouts + fidelity debt. Revisit if WebView2 ships a stable pinned-channel default, or if a future release fixes `tauri-apps/tauri#4531` upstream.
- **Tauri v2 with `fixedVersion`** — pays 180 MB to dodge the drift problem Electron solves for free.
- **electron-vite (alex8088, standalone)** — nicer dev loop, but needs `electron-builder` bolted on for NSIS. Lower-friction Windows path is Forge.
- **NSIS via Forge** — not a maker. Use `Squirrel.Windows` (the Electron norm) or `WiX MSI`.
- **react-virtuoso** — free tier's `followOutput` works, but its chat-grade component `VirtuosoMessageList` is a separate commercial EULA, and free-tier has documented dynamic-height glitches (#945, #1086).
- **virtua** — chat glue still hand-rolled; gives up the `anchorTo/followOnAppend` primitives TanStack now ships natively.
- **react-markdown + manual block memoization** — `streamdown` already productizes the AI SDK cookbook recipe.
- **highlight.js / lowlight** — visible fidelity loss; shiki-via-`@streamdown/code` already lazy-loads per language.
- **Solid / Svelte 5** — no evidence-backed win at this scale; default React stays.

## Repo layout (same repo, Rust → archive branch)

```
main                      — current state stays green; crates/ not removed until new stack works
└── archive/gpui-rust      — git branch cut before scaffold
    └── crates/claude-omp-desktop/
        crates/omp-rpc/

main (post-scaffold)
├── app/                   — Electron app (Forge + Vite; vite.{main,preload,renderer}.config.ts)
├── app/src/main/          — Electron main process (TypeScript; ports omp-rpc frame decoder)
├── app/src/main/native/   — Node-side child_process + taskkill tree teardown
├── app/src/preload/       — contextBridge → MessageChannelMain wiring
├── app/resources/         — theme assets (assets/theme/light.toml + generated tokens.css)
├── app/forge.config.ts    — Squirrel.Windows maker + Vite plugin config
├── docs/                  — UNCHANGED: rpc-events, transcript-rendering, window-shell,
│                            theme-tokens, subagent-panel, model-thinking-switcher
├── docs/research/         — adds web-stack-choice.md (this file), keeps gpui-windows-viability.md
├── assets/theme/light.toml — UNCHANGED (now loaded at build, not include_str!)
├── Cargo.toml             — archive only: keep Cargo workspace until archived branch stable, then remove
└── .gitignore             — add app/node_modules, app/out, app/dist
```

Archive step:

```bash
git checkout -b archive/gpui-rust            # branches from current main, not deleting anything
git push origin archive/gpui-rust
# merge is not needed; main stays intact while we build the new stack on it
# crates/ stays on main until the new stack is green, then removed in a single commit
```

## Scaffold commands (Electron Forge + Vite + React + TS)

Run inside `app/` once the directory exists (Forge's CLI scaffolds into the current directory).

```bash
# 1. create the app/ directory at repo root (parent is the existing repo)
mkdir app && cd app

# 2. scaffold Forge with the Vite + TypeScript template
#    (Forge 7.11.2; @electron-forge/plugin-vite is the renderer-dev path)
npx --yes create-electron-app@latest . \
    --template=vite-typescript

# 3. add renderer deps
npm i react react-dom
npm i -D @types/react @types/react-dom
npm i @tanstack/react-virtual streamdown @streamdown/code

# 4. main-process deps (port omp-rpc frame codec, child_process wiring)
npm i tree-kill
npm i -D @types/node

# 5. dev loop
npm start                    # vite HMR for renderer + electron hot-restart of main

# 6. Windows installer (Squirrel.Windows by default; add maker-wix for MSI)
npm run make
# output: out/make/squirrel.windows/x64/  out/make/zip/win32/x64/
```

The template ships `forge.config.ts` with `@electron-forge/plugin-vite` and the `squirrel.windows` maker wired; add `@electron-forge/maker-wix` if MSI is wanted. Note: Forge's Vite support is flagged **experimental** since 7.5.0 — pin Forge minor versions.

## Outstanding decisions to confirm before ticket 11

1. **Auto-update host**: static JSON on GitHub Releases (lowest friction, no infra) vs self-hosted dynamic endpoint. Default = GH Releases.
2. **Code-signing cert**: OV cert pre-June 2023 rules vs EV cert. EV avoids SmartScreen reputation accumulation but ~5× cost. Default = OV; revisit if SmartScreen friction is reported.
3. **Which Electron version to pin**: pick the one with the cleanest `titleBarOverlay` + DPI behaviour, hold it. Verify Snap Layouts + WCO manually before tagging.
4. **Where the `omp` port lives**: TypeScript decoder in `app/src/main/native/omp-rpc.ts`, wire-compatible with the archived Rust crate. Verify both decode the same fixture bytes.

## Sources

Raw per-claim citations live alongside this file:
- `web-stack-tauri-findings.md` — Tauri v2 maturity, Snap Layouts workaround, IPC streaming via `Channel<T>`, packaging, WebView2 evergreen regressions.
- `web-stack-electron-findings.md` — WCO titlebar, `MessageChannelMain` throughput (johnnyd710/electron-ipc-tests), `child_process` gotchas, Forge/electron-vite comparison, WebView2 vs Electron fidelity.
- `web-stack-renderer-findings.md` — `@tanstack/react-virtual` chat primitives, `streamdown` block memo + remend, `shiki` lazy-on-complete via `@streamdown/code`.