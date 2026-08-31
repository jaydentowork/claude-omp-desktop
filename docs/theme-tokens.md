# Theme tokens: measurement method and loader design

Companion to `assets/theme/light.toml`.

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
4. **Shadows.** Cards render flat; no drop shadow was measurable. Shadow
   tokens are empty rather than invented.
5. **Hover states.** No hover is captured in a static screenshot. Unmeasured.
6. **DPI.** All values are 1×. CSS pixels are logical pixels, so the values
   transfer directly, but rendering is untested on a scaled display —
   verify at 125 %/150 % Windows scaling (and note
   electron/electron#52208: `titleBarOverlay.height` has a known DPI
   resolution bug to check against the pinned Electron version).

## Half B — loader design

### Format: TOML

Kept from the original design. It supports comments (which the file uses
heavily to carry provenance) and reads cleanly for a flat token set.
JSON forbids comments, which would strand the measurement notes in a
separate document. The `[semantic]` / `[app]` section names are
historical (the split once mirrored a Rust theming library's schema) —
they stay because renaming buys nothing and the provenance comments
reference them.

### Consumption: CSS custom properties

The token file compiles to CSS custom properties on `:root`:

```css
:root {
  --color-background: #fcfcfb;   /* [semantic.colors] background */
  --text-primary: #0b0b0b;       /* [app.text] primary */
  --sidebar-width: 288px;        /* [app.layout] sidebar_width */
  /* ... every token, mechanically */
}
```

The mapping is a small build script (`tokens-to-css`), run by Vite at
build time and by the dev watcher on token-file change. Naming is
mechanical — TOML path → kebab-case variable — no lookup table, nothing
to drift. Components never hardcode a value the token file carries.

### Watching

Dev mode: the main process watches the token file (`fs.watch`,
debounced ~100 ms — editors write in bursts), regenerates the CSS
variables, and pushes them to the renderer, which swaps the values on
`document.documentElement` without a reload.

**On a malformed file: keep the last good values and surface the parse
error in-app.** Never fall back to defaults — silently reverting to a
different theme mid-edit is worse than showing stale values with an
error, because the developer cannot tell whether their edit applied.
Retain the last-good tokens in memory precisely for this case.

### Ship shape

Release builds embed the generated CSS at build time; a shipped build
never depends on a loose token file. The watcher is only armed in dev.

### Dark mode later

A sibling `dark.toml` with the same schema. `[meta].appearance`
distinguishes them; the CSS layer swaps the variable set. Because every
name is semantic (`text.muted`, not `gray_500`), the dark file is a
value swap with no code change — which was the point of insisting on
semantic naming.