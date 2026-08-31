# CLAUDE.md

## Project

`claude-omp-desktop` — Windows desktop client for the `omp` (oh-my-pi)
coding agent. Electron + React/TypeScript. Pixel-faithful Claude Code
Desktop light theme, minus Cowork. MVP is Windows-only. Source of truth
for the UI design: `docs/rpc-events.md`, `docs/transcript-rendering.md`,
`docs/window-shell.md`, `docs/theme-tokens.md`, `docs/subagent-panel.md`,
`docs/model-thinking-switcher.md`, and the issue map at
`.scratch/omp-desktop/map.md`.

**Stack decision**: `docs/research/web-stack-choice.md`. Electron
(pinned Chromium beats WebView2 evergreen for pixel fidelity), Electron
Forge + `@electron-forge/plugin-vite`, React + TS, `@tanstack/react-virtual`,
`streamdown` + `shiki` via `@streamdown/code`.

**History**: the first implementation was native GPUI (Rust). It lives
frozen on the local branch `archive/gpui-rust` — reference only, never
merged back. Tickets 01–10 in `.scratch/omp-desktop/issues/` document
that era; the engine-agnostic specs in `docs/` carry over unchanged.

## Layout (target — scaffold not yet landed)

- `app/` — Electron app (Forge + Vite). `src/main/` main process
  (spawns `omp`, ports the `omp-rpc` frame decoder to TS), `src/preload/`,
  `src/renderer/` React UI.
- `assets/theme/light.toml` — authoritative measured theme tokens.
- `assets/fixtures/streaming-capture.ndjson` — real recorded `omp`
  session; the TS decoder must decode it identically to the archived
  Rust `omp-rpc` crate.

## Hard-won runtime knowledge (keep)

- `omp` is spawned as a child process, speaks framed JSON over stdio.
- `omp` spawns LSP/extension grandchildren — Windows teardown needs
  `taskkill /pid <pid> /t /f`.
- Child death has no RPC event; the client synthesizes a `notice` +
  terminal `agent_end` from the stderr tail.
- Transcript must stream at 60fps with tens of thousands of rows; keep a
  benchmark asserting flat per-flush cost (the old
  `tests/streaming-cost.rs` claim, to be re-established in the new stack).
- Hot IPC path: `MessageChannelMain` + structured clone, coalesce
  flushes at ~16ms in main. Never `ipcRenderer.send` for the stream.
- Titlebar: `titleBarStyle: 'hidden'` + `titleBarOverlay` (WCO). Never
  draw a custom maximize button — Snap Layouts only work on the native
  WCO button.

## Conventions for working here

- **Simplest thing that works.** No abstraction not demanded by a ticket.
- **`omp` is authoritative.** Don't reimplement its provider registry,
  credential store, or session authority.
- **Headless first.** Anything that can run in `npm test` should — the
  streaming benchmark is the project's central performance claim and has
  to fail loud in CI, not only by eye.
- **Read the spec before the code.** The docs in `docs/` are
  engine-agnostic and still authoritative.

## Out of scope

Cowork, dark mode, macOS/Linux, settings/plugins/MCP UI, file browser,
local model inference.
