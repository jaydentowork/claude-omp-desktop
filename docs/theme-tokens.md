# Theme tokens: measurement method and loader design

Companion to `assets/theme/light.toml`. Resolves ticket 05.

## Half A — how the values were measured

Source: `Claude Code Images/light-view.png`, **1200×805, 1× DPI**, light theme.

Every colour in the token file was obtained by direct pixel sampling (Pillow),
not by eye. Three techniques:

- **Flat surfaces** — modal colour over a sample region known to be empty
  (e.g. sidebar background from x∈[20,260], y∈[380,560], 100% single-valued).
- **Text tiers** — darkest pixels within a known text run, which gives the
  glyph core before antialiasing lightens the edges.
- **Accents** — highest-saturation pixels (max−min channel > 25) within a
  region, which isolates coloured text and marks from grey surroundings.

Geometry came from **seam detection**: scanning a row or column and recording
positions where the colour delta exceeds a threshold.

### Confidence check

The accent sampled as `#d97757` — Claude's published brand orange. That the
method recovered a known-correct value independently is the main reason to
trust the rest.

### Key measurements

| Value | How | Result |
|---|---|---|
| Sidebar width | vertical seam at y=400 | x=287→288, so **288 px** |
| Tasks panel | vertical seams at y=620 | x=897..1180, **283 px** |
| Titlebar height | horizontal seam, panel column | divider at y=44 |
| Status bar | horizontal seam, panel column | divider at y=792 → **33 px** tall |
| Sidebar row height | selected-row tint extent | y=188..214 → **26 px** |
| Card extent | seams at y=205 | x=917..1171 → **254 px** wide |
| Composer box | seams at x=340 | y=713..757, border `#e1e1e0` |

### Palette

| Role | Value |
|---|---|
| Transcript / titlebar | `#fcfcfb` |
| Sidebar / status bar | `#fbfbf9` |
| Cards, inline code, git strip | `#f2f2f1` |
| Selected row tint | `#edece8` |
| Borders / dividers | `#e8e8e8` |
| Text primary | `#0b0b0b` |
| Text secondary | `#52514e` |
| Text muted | `#898781` |
| Link | `#184f95` |
| Brand accent | `#d97757` |
| Diff added | `#1e9e3c` |

### What could not be measured — do not treat as settled

1. **Font faces.** A screenshot cannot identify a typeface reliably. The file
   guesses `Styrene B` (Anthropic's brand face) with a `Segoe UI` fallback, and
   `Cascadia Mono` for the monospace runs. **Confirm against the real app.**
2. **Type scale.** Sizes and line-heights are inferred from glyph heights and
   baseline spacing, not read from a stylesheet. They are close, not exact.
   Expect to nudge these first when comparing side by side.
3. **`destructive` / `diff_removed`.** The screenshot contains no error state,
   and the `−0` renders too dark to sample cleanly. Both are placeholders.
4. **Shadows.** Cards render flat; no drop shadow was measurable. `ShadowTokens`
   are empty rather than invented.
5. **Hover states.** No hover is captured in a static screenshot. Unmeasured.
6. **DPI.** All values are 1×. GPUI works in logical pixels, so this should be
   correct, but it is untested on a scaled display.

## Half B — loader design

### Format: TOML

Chosen over RON and JSON. It supports comments (which the file uses heavily to
carry provenance), reads cleanly for a flat token set, and `toml` +`serde` are
already ubiquitous in a Rust dep graph. RON would be marginally more idiomatic
but is unfamiliar to anyone not writing Rust daily; JSON forbids comments,
which would strand the measurement notes in a separate document.

### Shape: two sections, one file

```toml
[semantic]   # maps 1:1 onto gpui_component::SemanticThemeTokens
[app]        # measured values their scale cannot express
```

Per ticket 02, our file is the **source of truth** and populates their
`SemanticThemeTokens` on load. The split exists because their scale genuinely
cannot hold what we measured: six `TextStyleToken`s can't carry the full type
scale, and t-shirt spacing (`xxs`…`xxl`) can't express a 288 px sidebar.

Field names under `[semantic]` match theirs **exactly**, so the mapping is
mechanical — a field-for-field struct copy, no lookup table, nothing to drift.
`[app]` invents names only where nothing corresponds.

### Mapping function

Runs at startup and on every reload:

```rust
fn apply(tokens: &Tokens, cx: &mut App) {
    cx.set_theme_tokens(tokens.semantic.to_gpui_component());  // mechanical copy
    cx.set_global(tokens.app.clone());                          // our own reads
}
```

### Watching

`notify` on the token file, debounced ~100 ms (editors write in bursts and
would otherwise trigger several reloads per save).

**On a malformed file: keep the last good values and surface the parse error
in-app.** Never fall back to defaults — silently reverting to a different
theme mid-edit is worse than showing stale values with an error, because the
developer cannot tell whether their edit applied. Retain the last-good `Tokens`
in memory precisely for this case.

### Ship shape

```rust
const DEFAULT_LIGHT: &str = include_str!("../assets/theme/light.toml");
```

Embedded at compile time. On startup, if a token file exists at the dev path,
load and watch it; otherwise use the embedded copy. A release build never
depends on a loose file, and hot-watching costs nothing in production because
the watcher is only armed when an on-disk file is found.

### Dark mode later

A sibling `dark.toml` with the same schema. `[meta].appearance` distinguishes
them. Because every name is semantic (`text.muted`, not `gray_500`), the dark
file is a value swap with no code change — which was the point of insisting on
semantic naming.
