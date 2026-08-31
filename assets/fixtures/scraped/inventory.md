# Scraped UI inventory (light theme)

Source: live capture of `claude.ai/code` (web Claude Code, the closest live
target to Claude Code Desktop) on 2026-08-31 via Chrome MCP, against the
user's logged-in profile. Light theme was set in *Settings → General →
Appearance* during capture and restored to *System* before the tab was
closed. See `README.md` for the re-scrape procedure and known gaps.

`light.toml` is a separate, older measurement set (per-pixel from
`Claude Code Images/light-view.png`). Where the live capture disagrees
with `light.toml`, this file is authoritative — `light.toml` should be
edited to match on the next theme token sweep.

## 1. Color roles (proposed CSS custom properties)

| Role | Proposed var | Live value | `light.toml` value | Notes |
|---|---|---|---|---|
| App background (pane) | `--color-app-bg` | `rgb(252,252,251)` ≈ `#fcfcfb` | `#fcfcfb` | matches |
| Sidebar background | `--color-sidebar-bg` | `color(srgb 0.984 0.984 0.976)` ≈ `#fbfbf9` | `#fbfbf9` | matches |
| Card / code-block surface | `--color-surface-2` | `#f2f2f1` | `#f2f2f1` | matches |
| Selected row tint | `--color-bg-selected` | n/a (sampled as `bg-fill-selected-hover`) | `#edece8` | gap — see §6 |
| Border / divider | `--color-border` | `color(srgb 0.04 … / 0.10)` ≈ `rgba(11,11,11,0.10)` | `#e8e8e8` | web uses translucency, not flat grey |
| Text primary | `--text-primary` | `rgb(11,11,11)` ≈ `#0b0b0b` | `#0b0b0b` | matches |
| Text secondary | `--text-secondary` | n/a — sampling needed | `#52514e` | unconfirmed live |
| Text muted | `--text-muted` | n/a — sampling needed | `#898781` | unconfirmed live |
| Link | `--color-link` | n/a — sampling needed | `#184f95` | unconfirmed live |
| Brand accent | `--color-accent` | n/a — class `text-accent` exists, exact RGB not sampled | `#d97757` | unconfirmed live |
| Diff added | `--color-diff-added` | n/a | `#1e9e3c` | unconfirmed live |
| Diff removed | `--color-diff-removed` | n/a | n/a | unknown |
| Inline code text | `--color-inline-code-fg` | `rgb(142,38,38)` ≈ `#8e2626` | n/a | web uses red for inline code |
| Inline code bg | `--color-inline-code-bg` | `rgba(11,11,11,0.05)` | n/a | translucent fill |
| Inline code border | `--color-inline-code-border` | `rgba(11,11,11,0.10)` | n/a | matches divider translucency |
| Composer border | `--color-composer-border` | n/a — compositor class `rounded-card` | `#e1e1e0` | unconfirmed live |

## 2. Typography

| Slot | Font stack (live) | Size | Weight | LH | Notes |
|---|---|---|---|---|---|
| Body / paragraph | `anthropic-sans, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, …` | 14px | 400 | 20px | confirms Anthropic sans family + system fallback |
| Inline code | `anthropic-mono, ui-monospace, monospace, "SF Mono", ui-monospace, Menlo, Consolas, monospace` | 12.6px | 400 | 12.6px | mono family confirmed |
| Table | anthropic-sans stack | 14px | 400 (cells), 500 (th) | 20px | |
| Composer | anthropic-sans stack | 13px | 400 | 19px | |
| Sidebar | anthropic-sans stack | 14px | 400 | 21px | matches measured `text_sm` rhythm |

**Findings that contradict `light.toml`:**

- The light.toml document specifies **Cascadia Mono** for monospace runs.
  Live capture shows **anthropic-mono** (`ui-monospace, "SF Mono",
  Menlo, Consolas, monospace` fallback). The desktop web build ships
  anthropic-mono, not Cascadia. Light.toml should be updated to
  `anthropic-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace`
  for monospace roles.
- Light.toml labels font as "Styrene B" — live uses **anthropic-sans**
  with a long system-ui fallback chain. Same conclusion
  (`light.toml` font names were guesses; capture is authoritative).

## 3. Spacing and radii

| Role | Value |
|---|---|
| Sidebar width | 288px (matches `light.toml`) |
| Titlebar height | 44px (matches) |
| Code-block container radius | 6px (table also uses 6px) |
| Inline-code radius | ~5px (5.04px computed) |
| Inline-code padding | `0.7875px 3.15px` (~1px × 3px) |
| Table th/td padding | `6.125px 10.5px` |
| Composer border-radius | class `rounded-card` — Tailwind/radius scale token (exact px not sampled live) |

## 4. Geometry (re-measured from capture)

| Surface | Capture (web) | light.toml | Note |
|---|---|---|---|
| Sidebar | 288 px (rect `[0,0,288,750]`) | 288 px | matches |
| Titlebar | 287 × 44 px | 44 px tall | matches |
| Tasks panel | not present in web UI (replaced by diff/changes panel) | 283 px | gap — see §6 |
| Status bar | not present in web UI | 33 px | gap |

## 5. Border system

Web uses **translucent** borders (`rgba(11,11,11,0.10)`), not flat grey.
If the desktop rebuild matches the web behavior, prefer
`border: 1px solid color-mix(in oklch, currentColor 10%, transparent)`
or the equivalent rgba. Flat `#e8e8e8` is a `light.toml` approximation
that should be revised.

## 6. Known gaps (web ≠ desktop)

| Pane | What's missing on web | Action |
|---|---|---|
| Window shell | No custom titlebar cluster (`hamburger · sidebar toggle · search · back · forward`); no WCO overlay | Web has *only* the `.df-titlebar` (44px, AppKit-style). Desktop rebuild must author this from `docs/window-shell.md` directly — not reproducible from capture. |
| Tasks panel | Right side is the **diff/changes** panel, not background-tasks. Subagent taxonomy from `docs/subagent-panel.md` is not visible in any web route. | Capture is therefore only a layout reference (right-rail width, header style). Subagent cards need a desktop-build re-scrape. |
| Status bar | No status bar (model/thinking chips, account row, spinner) lives in web. | These live below the composer on web but the model/thinking affordances are pill chips rendered in the composer footer band; the desktop shell status bar is not in scope of this scrape. |
| Selected-row tint | No session selected in capture → bg-selected not sampled. | Re-scrape with a non-default session selected. |
| Hover/focus states | Not captured. | Add to next re-scrape procedure. |