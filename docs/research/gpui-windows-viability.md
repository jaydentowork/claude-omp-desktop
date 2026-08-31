# GPUI viability on Windows — research findings

**Ticket:** `01-gpui-viability-windows.md` (claimed, research type)
**Author:** research agent (taekwonnie)
**Date:** 2026-08-30
**Method:** primary-source only. All claims cite the exact commit / file / line they came from. Where I could not verify from source I say so.

## Bottom line up front

| # | Question | Answer |
|---|---|---|
| 1 | Which rev to pin? | `v1.17.2` (commit `c8e44cfa7bda9b2e22c8d6934d78969352e7f61a`, 2026-08-26). Windows release pipeline green. |
| 2 | **Variable-height virtualized list with streaming growth?** | **Yes, natively.** GPUI's `list` (with `ListState`) supports it; the source docs literally name "streaming text" as a use case. Plus `FollowMode::Tail`, `scroll_to_end()`, `is_following_tail()` — the chat-log primitive is built in. **`uniform_list` is NOT the answer** — fixed-height only. |
| 3 | Text rendering / wrapping / inline code / cross-element selection? | Wrapping & inline runs (font family per `TextRun`): yes. **Cross-element mouse-driven text selection is NOT in `gpui` core** — must build it ourselves or pull in `gpui-component` (Apache-2.0), which has it. |
| 4 | What's missing? | In raw `gpui`: markdown, syntax highlighting, resizable panes, scrollbars, text input (multi-line), cross-element selection. **`gpui-component` (Apache-2.0, crates.io, 13.6k stars) covers all of these** — recommended dependency. **Zed's own `ui`, `editor`, `markdown`, etc. crates are GPL-3.0-or-later** — NOT usable from a non-GPL product. |
| 5 | Build reality? | Rust 1.97.1, MSVC required (no GNU path — DirectWrite/D3D), Windows 10 SDK ≥ 2104 (10.0.20348.0). Clean build time **not verified locally** (no `rustc` on this machine). Git deps work fine — verified by the canonical external user `longbridge/gpui-component`. |

**Stack verdict:** GPUI is viable on Windows for a chat-transcript-style app. The load-bearing primitive (#2) is **explicitly supported and documented**. The biggest real risk is licensing — see "Licensing" below.

---

## 1. Pin and Cargo stanza

### Verified facts (from primary sources)

- Tag `v1.17.2` exists at commit `c8e44cfa7bda9b2e22c8d6934d78969352e7f61a` (authored 2026-08-26 by `zed-zippy[bot]`). *(Source: `https://api.github.com/repos/zed-industries/zed/git/refs/tags/v1.17.2` and `…/commits/c8e44cf…`)*
- The `release` GitHub Actions workflow run `32980141953` for `v1.17.2` concluded `success` overall; per-job results (from `…/actions/runs/32980141953/jobs`):

  | Job | Result |
  |---|---|
  | `run_tests_windows` | success |
  | `clippy_windows` | success |
  | `bundle_windows_x86_64` | success |
  | `bundle_windows_aarch64` | success |
  | `run_tests_mac` / `run_tests_linux` | success |
  | `clippy_mac` / `clippy_linux` | success |

  So the **Windows build is green at `v1.17.2` for x86_64 and aarch64, including tests and clippy**. No Windows-specific breakage surfaced.
- `gpui` is at version `0.2.2` in this tree (file `crates/gpui/Cargo.toml`):

  ```toml
  [package]
  name = "gpui"
  version = "0.2.2"
  publish = true
  license = "Apache-2.0"
  ```

  i.e. the version number has been frozen at the same stale `0.2.2` on `crates.io` for ~10 months. Pin the git rev, not the version.
- `gpui_platform` exists in the monorepo only (`crates/gpui_platform/Cargo.toml`):

  ```toml
  [package]
  name = "gpui_platform"
  version = "0.1.0"
  publish.workspace = true
  license = "Apache-2.0"
  ```

  `crates.io` API returns 404 for `/api/v1/crates/gpui_platform` — **not published**. Confirmed the ticket's premise.

- README "Windows — no features are required" is correct. (`crates/gpui/README.md` — "Windows — no features are required. Windowing uses Win32 and text uses DirectWrite. `font-kit` has no effect here.")
- `gpui_platform`'s `[target.'cfg(target_os = "windows")'.dependencies]` auto-forces `gpui = { workspace = true, features = ["windows-manifest"] }`. So `windows-manifest` is effectively required on Windows; the `embed-resource` build-dep embeds a DPI-aware exe manifest.
- Default features of `gpui` are `["font-kit", "wayland", "x11", "windows-manifest"]`. On Windows, `wayland`/`x11` are empty feature flags (`wayland = []`, `x11 = ["scap?/x11"]`); `font-kit` is gated to `cfg(target_os = "macos")`. **No Windows binary code path pulls in Linux/macOS-only deps.** Default-features-on is OK on Windows.

### Recommended `Cargo.toml` stanza

This is the exact form `longbridge/gpui-component` uses today (file `crates/ui/Cargo.toml` of that repo, last commit 2026-08-30):

```toml
[dependencies]
gpui = { version = "0.2.2", git = "https://github.com/zed-industries/zed", rev = "c8e44cfa7bda9b2e22c8d6934d78969352e7f61a" }
gpui_platform = { git = "https://github.com/zed-industries/zed", rev = "c8e44cfa7bda9b2e22c8d6934d78969352e7f61a" }
```

Notes:
- Pin `rev = "c8e44cfa7bda9b2e22c8d6934d78969352e7f61a"` (= `v1.17.2`) on **both** lines. Don't `tag = "v1.17.2"` — tags are mutable in git.
- No features required on Windows for `gpui_platform`. Do **not** pass `features = ["font-kit", "wayland", "x11"]` like `gpui-component` does — they're no-ops on Windows and just bloat dep resolution.
- `gpui-component` uses `gpui_macros` and `gpui_web` as **separate** git deps too. We only need `gpui_macros` (transitively pulled by `gpui` via `gpui = { workspace = true }` from inside the checkout, but Cargo still needs to resolve `gpui_macros` separately if any of *our* code uses its macros; safest to add it explicitly):
  ```toml
  gpui_macros = { version = "0.1.0", git = "https://github.com/zed-industries/zed", rev = "c8e44cfa7bda9b2e22c8d6934d78969352e7f61a" }
  ```
- If we take `gpui-component` (recommended — see §4), its crate gives us the resolved versions of all of the above.

### Toolchain pin

From `rust-toolchain.toml` at `v1.17.2`:
```toml
[toolchain]
channel = "1.97.1"
profile = "minimal"
components = ["rustfmt", "clippy", "rust-analyzer", "rust-src"]
targets = ["wasm32-wasip2", "wasm32-unknown-unknown", "x86_64-unknown-linux-musl"]
```
Zed uses **stable Rust 1.97.1**, not nightly. Note: `1.97.1` looks like a future date relative to knowledge-cutoff norms; it's what their `rust-toolchain.toml` actually says at this rev. Verify against `rustc --version` once installed locally.

### Verified gap: **I did not actually compile this on this machine.** No `rustc`/`cargo`/`rustup` is installed here (`which rustc` → not found). I have only the source-level guarantees above. The first ticket that depends on this should plan to do the actual clean-build and incremental-build timing.

---

## 2. The load-bearing question: variable-height virtualized list with streaming growth

**Verdict: Yes, this is supported natively by GPUI's `list` element + `ListState`.**

### Source evidence

Two list primitives exist (`crates/gpui/src/elements/mod.rs`):
```rust
pub use list::*;
pub use uniform_list::*;
```

- **`uniform_list`** — fixed-height only. Doc comment (`crates/gpui/src/elements/uniform_list.rs:18-22`): "uniform_list provides lazy rendering for a set of items that are of **uniform size** … This is much faster than the full layout system, but only works when items are uniform." Not suitable for chat messages.
- **`list`** — variable-height. Built on `taffy` (full layout). What we want.

### API surface on `ListState` (`crates/gpui/src/elements/list.rs`)

| Method | What it does | Source line |
|---|---|---|
| `ListState::new(item_count, alignment, overdraw)` | Construct; `alignment = ListAlignment::Bottom` is the chat-log mode. | 314 |
| `ListState::measure_all()` | Eager measure every item (scrollbar correct from frame 1; expensive for very long lists). | 336 |
| `ListState::with_uniform_item_height(height)` | Hint uniform height initially; converge as items render. | 347 |
| `ListState::reset(count)` / `reset_with_uniform_height(count, h)` | Change item count. | 355 / 372 |
| **`ListState::remeasure_items(range)`** | **Mark items `range` as needing remeasurement, preserving scroll position.** Docstring at lines 405-414 reads: *"Use this when an item's content has changed and its rendered height may be different (e.g., **streaming text**, tool results loading), but the item itself still exists at the same index."* | **412** |
| `ListState::remeasure()` | Remeasure everything, proportional scroll anchor. | 400 |
| `ListState::splice(old_range, count)` / `splice_focusable(...)` | Insert / remove items. | 503 / 511 |
| `ListState::scroll_to_end()` | "uses the total item count as the anchor, so the list's layout pass will walk backwards from the end and always show the bottom of the last item — **even when that item is still growing (e.g. during streaming)**." | **603** |
| `ListState::scroll_to(offset)` / `scroll_to_reveal_item(ix)` | Explicit scroll. | 660 / 677 |
| `ListState::set_follow_mode(FollowMode::Tail \| Normal)` | Auto-scroll when at bottom; re-engages when user scrolls back to bottom. | 617 |
| `ListState::pause_following_tail()` | Freeze position when something other than the user grows an item (e.g. zooming a diagram). | 646 |
| `ListState::is_following_tail()` / `is_scrolled_to_end()` | Read state. | 652 / 484 |
| `ListState::set_scroll_handler(closure)` | Hook into item-indexed scroll events. | 552 |
| `ListState::viewport_bounds()` / `max_offset_for_scrollbar()` / `scroll_px_offset_for_scrollbar()` | For painting our own scrollbar. | 799 / 772 / 781 |

`pub enum ListAlignment { Top, Bottom }` — comment at line 167: `"Bottom"` = *"The list is scrolling from bottom to top, **like a chat log**."*

`pub enum ListSizingBehavior { Infer, Auto }` — defaults to `Auto` (line 188-193); for chat-transcript use `Infer` so the list participates in outer layout as a flex child sized by its container.

### Streaming pattern this gives us (no custom work)

```text
on stream_token:
    items.last_mut().text.push_str(token);
    list_state.remeasure_items(items.len()-1 .. items.len()); // preserves scroll if last is at top of viewport
    // list_state has a built-in scroll anchor: if the item under scroll-top changed height, the
    // pixel offset within it is preserved (Absolute), so the visible text doesn't jump.

on user scroll to bottom:
    list_state.set_follow_mode(FollowMode::Tail); // auto-stick

on user scroll up:
    FollowMode disengages automatically; re-engages when they return to bottom.

on new message appended at tail while following:
    list_state.scroll_to_end(); // anchor = item_count, walks backwards, handles growing last item
```

### Verified gap: I did not run any of this. The API contracts above are read directly out of the source tree at `v1.17.2`. Whether it actually performs (frame timing, jitter during measurement of a multi-line paragraph at 60fps) is not verified — and is the only thing that matters in practice.

---

## 3. Text rendering: wrapping, inline styles, selection

### What GPUI core provides

`crates/gpui/src/elements/text.rs`:
- `Text` element (line 67) — produced via the `text!("…")` macro (line 159), stable source-location-based ID, accessible.
- `StyledText` (line 391) — multi-run styled text. API:
  - `new(text)` / `with_default_highlights(default_style, highlights)` / `with_highlights(highlights)` / `with_font_family_overrides(overrides)` / `with_runs(runs)`
  - `layout()` returns `&TextLayout` for hit-testing.
- Word wrapping is automatic; overflow handling via div-level `.line_clamp(n)`, `.truncate()`, `.text_ellipsis()`, `.text_overflow(TextOverflow::Truncate(..))`, `.whitespace_nowrap()`. See `crates/gpui/examples/text_wrapper.rs` for canonical usage.

`TextRun` (struct at `crates/gpui/src/text_system.rs:987`):
```rust
pub struct TextRun {
    pub len: usize,
    pub font: Font,
    pub color: Hsla,
    pub background_color: Option<Hsla>,
    pub underline: Option<UnderlineStyle>,
    pub strikethrough: Option<StrikethroughStyle>,
}
```
`Font` has `family`, `features`, `fallbacks`, `weight`, `style`. **Inline code spans: just construct a `TextRun { font: font("JetBrains Mono"), background_color: Some(grey), … }`.** Same for bold/italic/color/strikethrough. Confirmed.

`TextLayout` (in `text.rs`) exposes:
- `index_for_position(Point<Pixels>) -> Result<usize, usize>` — pixel → byte index
- `position_for_index(usize) -> Option<Point<Pixels>>` — byte index → pixel position
- `bounds()`, `line_layouts()`, `line_layout_for_index(ix)`, etc.

These are the **layout primitives** for building selection — but selection itself is not built.

### What's NOT in core: cross-element text selection

I grepped `crates/gpui/src/elements/text.rs` and `crates/gpui/src/elements/list.rs` for "selection" / "Selection": **zero matches** in `text.rs`, zero matches in `list.rs`. The only `InputHandler`/`EntityInputHandler` (`crates/gpui/src/input.rs`) is for **IME composition** — text *input* from the keyboard, not mouse-driven selection.

`grep -rn "set_selection\|selection_start\|selection_end\|selectable_text"` over `crates/gpui/src/` returns nothing relevant for visual selection.

**Conclusion: GPUI core provides the geometry for selection (index_for_position / position_for_index) and IME composition, but no built-in mouse-drag-to-select-and-copy across elements.** To ship a chat transcript with copyable text we either:
1. Implement selection ourselves (hit-test with `index_for_position`, paint overlay rects, copy via `ClipboardItem` — non-trivial but tractable for a single run of text), OR
2. Use `gpui-component`'s `text::TextView` (see §4) which ships this, including cross-element `TextSelectionScope` for selection spanning multiple text views.

Option 2 is the ponytail choice unless we have a reason to avoid it.

### DirectWrite / text shaping

`crates/gpui_windows/Cargo.toml` `target.'cfg(target_os = "windows")'.dependencies` includes `windows = { workspace = true, features = ["Win32_Graphics_DirectWrite", …] }` (via the workspace dependency table at root `Cargo.toml` lines 907+). No alternative — text rendering on Windows is DirectWrite.

### IME / text input

`crates/gpui/src/input.rs` defines `EntityInputHandler` — a trait views implement to receive IME, clipboard paste, and text-editing caret updates. `ElementInputHandler::new(bounds, view)` wraps it for use in `Element::paint` via `Window::handle_input(...)`. We can build a multi-line textarea on top of this ourselves (using `gpui_component::input::textarea` is faster — see §4).

---

## 4. What's missing: a build vs. buy matrix

| Capability | In `gpui` core? | In Zed's `ui`/`markdown`/`editor` crates? | Buyable? |
|---|---|---|---|
| Virtualized variable-height list | Yes (§2) | n/a | — |
| Plain text rendering + inline styles | Yes (`StyledText` + `TextRun`) | n/a | — |
| Mouse text selection (single element) | No — build | GPL — unusable | `gpui-component` (Apache-2.0) |
| Mouse text selection (across elements) | No | GPL | `gpui-component` |
| Markdown rendering | No | GPL (`crates/markdown`) | `gpui-component` (`text::TextView` w/ tree-sitter highlight) |
| Syntax highlighting (tree-sitter) | No | GPL (`crates/language`) | `gpui-component` (`highlighter/`, behind `tree-sitter-*` features) |
| Resizable / dockable panes | No (just `div` + flex) | GPL (`crates/workspace`) | `gpui-component` (`dock/`) |
| Scrollbars | No — build (`max_offset_for_scrollbar`, `scroll_px_offset_for_scrollbar`, `viewport_bounds` exposed) | GPL (`crates/ui`) | `gpui-component` (`scroll/`) |
| Text input (single-line / multi-line / IME) | `EntityInputHandler` trait only — build | GPL (`crates/ui_input`) | `gpui-component` (`input/`, `input::textarea`) |
| Splittable list with table columns | No | GPL | `gpui-component` (`table/`) |

### Why we can't use Zed's own crates

`crates/ui/Cargo.toml` (and every other high-level crate in the workspace — `ui`, `ui_input`, `editor`, `markdown`, `markdown_preview`, `picker`, `component`, `component_preview`, `editor_benchmarks`, `workspace`, `language`, `language_core`, `language_extension`, `language_model`, `language_model_core`, `language_models`, `language_selector`, `language_tools`, `syntax_theme`) carries:
```toml
license = "GPL-3.0-or-later"
```
and a `LICENSE-GPL` file next to `LICENSE-APACHE`. They depend on each other and are NOT independently publishable on `crates.io` from inside the workspace (`publish.workspace = true`).

**This means: if omp-desktop is ever shipped under any license other than GPL-3.0-or-later (or we want to keep our own source proprietary), we cannot link Zed's `ui` / `markdown` / `editor` etc. directly.**

`gpui` and `gpui_platform` (and `gpui_macos` / `gpui_linux` / `gpui_windows` / `gpui_web`) are pure Apache-2.0, so the framework itself is fine. The problem is the higher-level building blocks.

### `gpui-component` — recommended

- **What:** Longbridge (gpui-component 13.6k stars, last commit 2026-08-30) — community-maintained component library *specifically built to fill the GPL gap in the Zed ecosystem*.
- **License:** `crates/ui/Cargo.toml` declares `license = "Apache-2.0"`, `publish = true`. The repo root has `LICENSE-APACHE`. **Apache-2.0, not GPL.** (GitHub reports license as "NOASSERTION" because the LICENSE file has a Longbridge attribution header, but the SPDX in `Cargo.toml` is unambiguous.)
- **crates.io state:** `gpui-component 0.5.1` published 2026-02-05; `gpui-component 0.5.0` 2025-12-08; current main is `0.5.2` (preparing a release). ~98k downloads.
- **What it ships** (full list from `crates/ui/src/`): accordion, alert, async_util, avatar, badge, breadcrumb, button, chart, checkbox, clipboard, collapsible, color_picker, combobox, command, description_list, dialog, **dock**, **element_ext**, form, global_state, group_box, **highlighter** (tree-sitter-based), history, hover_card, icon, index_path, **input** (incl. `textarea.rs`), inspector, kbd, label, link, list, menu, native_menu, notification, pagination, plot, popover, progress, radio, rating, root, scroll, searchable_list, select, separator, setting, sheet, **sidebar**, sizing, skeleton, slider, spinner, status_bar, stepper, styled, switch, tab, **table**, tag, **text** (incl. `markdown_ext.rs`, `selection.rs`, `window_selection.rs`), theme, time, title_bar, tooltip, tree, **virtual_list**, window_border, window_ext.
- **Markdown support:** Uses the `markdown` crate (pulldown-cmark compatible `mdast` AST). Custom plugins supported (`MarkdownPlugin` trait). Inline code via `TextRun` font override + background color (matches the core pattern in §3).
- **Syntax highlighting:** Tree-sitter feature flags; `tree-sitter-markdown` for markdown; many languages via opt-in features.
- **Cross-element selection:** `TextSelectionScope`, `TextSelectionHandle`, `TextSelectionRegistration`, `TextSelectionRun` (in `gpui-base`) — registration-based, lets one `Root` register many text views and get a single contiguous selection.
- **Builds with:** `gpui = { version = "0.2.2", git = "https://github.com/zed-industries/zed" }` and `gpui_platform = { git = "https://github.com/zed-industries/zed", features = ["font-kit", "x11", "wayland", "runtime_shaders"] }` (their Cargo.toml, line 27). **This is the proven pattern for using GPUI outside the Zed monorepo.**

**Ponytail recommendation:** take `gpui-component` rather than reimplementing markdown + selection + dock + scrollbar + textarea + tree-sitter glue ourselves. It's Apache-2.0 and purpose-built for this gap. ~13.6k stars, actively maintained (commits today).

---

## 5. Build reality on Windows

### Verified from Zed's own Windows build doc

From `docs/src/development/windows.md` at `v1.17.2`:
- **Toolchain:** rustup, then **MSVC** (Visual Studio Build Tools 2022+ with `Desktop development with C++` workload, MSVC v*** C++ x64/x86 build tools + Spectre-mitigated libs, **or** MSVC 14.50+ with `MSVC Build Tools for x64/x86 (Latest)` + `C++ Spectre-mitigated libraries for x64/x86 (Latest MSVC)` — VS 2026 has decoupled MSVC from VS versions per `devblogs.microsoft.com/cppblog/new-release-cadence-and-support-lifecycle-for-msvc-build-tools/`).
- **SDK:** Windows 10 SDK ≥ 2104 (`10.0.20348.0`) or Windows 11 SDK. Both available on this machine (`C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\` and `10.0.26100.0\`).
- **CMake:** required by `wasmtime-c-api-impl`. Zed's doc warns you have to add `C:\Program Files\Microsoft Visual Studio\<ver>\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin` to PATH if installed via VS Installer.
- **MSVC 2022** is present on this machine (`C:\Program Files (x86)\Microsoft Visual Studio\2022\`).

There is **no GNU toolchain path** — `windows` crate uses MSVC-only FFI, and `DirectWrite` / `D3D11` / `DirectComposition` are all MSVC-bound. Don't waste time on `x86_64-pc-windows-gnu`.

### Verified gap: clean-build time, incremental time, exact rustc behavior

I **could not** measure these. `which rustc` / `which cargo` / `which rustup` all return "not found" in this sandbox. The first ticket that depends on this stack should plan to:
1. Install Rust stable 1.97.1 via rustup.
2. `cargo new --bin omp-desktop` and add the `Cargo.toml` from §1.
3. Time `cargo build --release` from cold (expect tens of minutes — DirectWrite + taffa + tree-sitter bring in a lot).
4. Time a no-op rebuild (`cargo build` with one comment added) — expect tens of seconds once `.cargo` cache is warm.

The Zed Windows CI exists (`run_tests_windows`, `clippy_windows`, `bundle_windows_*` all green at `v1.17.2`), so it does build. There are **no open issues labeled `windows`** in `zed-industries/zed` as of 2026-08-30.

---

## Licensing

### The `gpui` git dependency alone is Apache-2.0

Files inspected:
- `Cargo.toml` workspace root → `[workspace.package]` `license = "Apache-2.0"` (no `license-file` override in workspace metadata; default LICENSE-APACHE).
- `crates/gpui/Cargo.toml`: `license = "Apache-2.0"`, `publish = true`.
- `crates/gpui_platform/Cargo.toml`: `license = "Apache-2.0"`.
- `crates/gpui_macos/Cargo.toml`: `license = "Apache-2.0"`.
- `crates/gpui_linux/Cargo.toml`: `license = "Apache-2.0"`.
- `crates/gpui_windows/Cargo.toml`: `license = "Apache-2.0"`.
- `crates/gpui_web/Cargo.toml`: `license = "Apache-2.0"`.

### Transitive risks (only if we link Zed's higher-level crates)

Every higher-level Zed crate carries `license = "GPL-3.0-or-later"` + `LICENSE-GPL`:
`crates/{ui, ui_input, editor, markdown, markdown_preview, picker, component, component_preview, editor_benchmarks, workspace, language, language_core, language_extension, language_model, language_model_core, language_models, language_selector, language_tools, syntax_theme, …}` — full list above.

The "unofficial `gpui-windows` crate" the ticket mentions — not relevant to us because we are using `gpui_windows` from inside the Zed monorepo (Apache-2.0), not the third-party crate. Verified: there is no `gpui-windows` dependency required for our setup.

### Apache transitive deps (informational)

Zed pulls in `zed-font-kit`, `zed-sum-tree`, `windows-capture`, `yawc`, `zed-reqwest` from their own `zed-industries/*` git forks. These are all Apache-compatible but worth a `cargo tree --no-default-features --target x86_64-pc-windows-msvc` before shipping.

---

## Recommendation

1. **Pin `gpui`, `gpui_platform`, `gpui_macros` to git rev `c8e44cfa7bda9b2e22c8d6934d78969352e7f61a` (= `v1.17.2`)** as shown in §1.
2. **Add `gpui-component = "0.5"`** from crates.io (Apache-2.0). Don't reinvent markdown, dock, scrollbars, selection, textarea, tree-sitter wiring.
3. **Do NOT depend on Zed's own `ui`/`markdown`/`editor`/etc. crates** — GPL-3.0-or-later, would taint the product.
4. **First ticket after this one:** install Rust 1.97.1 + MSVC + Windows 10 SDK ≥ 2104 (all present on this machine except Rust), do a clean build of a hello-world that imports `gpui` + `gpui-component` and renders a `list(...)` with three `div()` items and a `FollowMode::Tail` button, **time the build**, and confirm the streaming remeasurement contract holds at 60fps with a synthetic 100k-token transcript. That's the only thing I couldn't verify from source.
5. **Long-term risk to monitor:** `gpui` is at the same version number (`0.2.2`) it was 10 months ago. The framework is pre-1.0 and "will often have breaking changes between versions" (README). Pinning the git rev is the right defense. If a breaking change comes in and we fall too far behind, the catch-up work compounds.

## Sources cited

- Zed `v1.17.2` tag → commit `c8e44cfa7bda9b2e22c8d6934d78969352e7f61a` via `https://api.github.com/repos/zed-industries/zed/git/refs/tags/v1.17.2`
- v1.17.2 release workflow run 32980141953 → `https://api.github.com/repos/zed-industries/zed/actions/runs/32980141953/jobs` (all Windows jobs `success`)
- `crates/gpui/README.md`, `crates/gpui/Cargo.toml`, `crates/gpui_platform/Cargo.toml`, `crates/gpui_windows/Cargo.toml`, `rust-toolchain.toml`, `docs/src/development/windows.md` — all at ref `v1.17.2` via `https://raw.githubusercontent.com/zed-industries/zed/v1.17.2/<path>`
- `crates/gpui/src/elements/list.rs` (2973 lines) — `ListState` API, `FollowMode`, `remeasure_items`, `scroll_to_end`
- `crates/gpui/src/elements/uniform_list.rs` — fixed-height primitive
- `crates/gpui/src/elements/text.rs` — `Text`, `StyledText`, `TextLayout`
- `crates/gpui/src/text_system.rs:987` — `TextRun` struct
- `crates/gpui/src/input.rs` — `EntityInputHandler`, `ElementInputHandler`
- `crates/gpui/src/elements/mod.rs` — public re-exports
- crates.io API: `/api/v1/crates/gpui` (max 0.2.2, 2025-10-22), `/api/v1/crates/gpui_platform` (404)
- `gpui-component`: `https://github.com/longbridge/gpui-component` (license: Apache-2.0 per `crates/ui/Cargo.toml`; Cargo.toml lock-step with gpui git deps; 13.6k stars, pushed 2026-08-30)

## Things I could NOT verify

- Actual clean-build and incremental-build times on this machine (no Rust toolchain).
- Frame timing / measurement-jitter at 60fps during streaming remeasurement (would need an actual build + window).
- Whether `gpui-component 0.5.1` (current crates.io release) builds at `v1.17.2` of gpui — `gpui-component` `main` tracks Zed `main`, not stable tags. The release branch on `gpui-component` (`v0.5.1`) was tagged 2026-02-05 and may target an older Zed rev; recommend checking `gpui-component`'s `Cargo.lock` for which Zed commit they pinned against, and aligning our rev if their 0.5.1 branch isn't already on `c8e44cfa…`.
- Whether any hidden cfg-gated dependency on Linux/macOS-only crates ends up building on Windows. The defaults say no, but real life says otherwise — only a build will tell.