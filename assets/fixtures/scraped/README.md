# Scraped UI fixtures

Live capture of Claude Code (web, `claude.ai/code`) — the pixel source
of truth for the clone, per the map's standing preference
("UI source of truth is the live scrape"). Captured 2026-08-31,
light theme, logged-in profile, Chrome MCP.

## Why web, not the desktop app

Claude Code Desktop was not available for automated capture in this
pass (Chrome MCP drives the browser only). The web build shares the
renderer with the desktop app; the frame differs. Everything inside
the panes (transcript, sidebar body, composer, pickers) is treated as
authoritative. The window shell (custom titlebar cluster, WCO overlay,
status bar) does **not** exist on web — see `inventory.md` §6 for the
full gap list. Those surfaces stay authored from `docs/window-shell.md`.

## Layout convention

```
assets/fixtures/scraped/
  <pane>/screenshot-*.jpg      # full-window captures, 1219×750 default, 800×750 narrow
  <pane>/dom*.html             # outerHTML of the pane subtree
  <pane>/*-tree.json           # element walk: class, rect, computed styles
  <pane>/computed-styles.json  # getComputedStyle dumps for key elements
  <pane>/interaction*.gif      # one happy-path interaction recording
  raw-dump-*.json              # unprocessed capture payloads (source for the above)
  inventory.md                 # distilled tokens → proposed CSS custom properties
  README.md                    # this file
```

Panes: `transcript`, `session-sidebar`, `subagent-panel` (captured as
the web diff panel — see gaps), `model-thinking-switcher`, `composer`,
`window-shell` (web titlebar only).

Screenshots are JPEG (Chrome MCP's capture format) at 1219×750 css-px.
Colors in `inventory.md` come from `getComputedStyle`, not pixel
sampling, so JPEG artifacts don't matter; treat the JPEGs as layout
references, not color sources.

## Re-scrape procedure (diff-as-spec-update)

1. Chrome MCP against the logged-in profile. `tabs_context_mcp` →
   navigate `https://claude.ai/code`.
2. Settings → General → Appearance → **Light** (remember the previous
   value; restore it when done).
3. New session (do not reuse the user's existing sessions), any repo,
   prompt it to emit: paragraph, bullet list, python code block,
   table, one `echo hello` shell run. This exercises every transcript
   renderer in one message.
4. Per pane: screenshot at default width, screenshot at 800px width,
   `outerHTML` of the pane subtree, `getComputedStyle` walk (the JS
   snippets are reproducible from the raw-dump files' shape), one
   interaction GIF (`gif_creator`).
5. Large payloads: stash JSON on `window`, then Blob-download —
   `javascript_tool` responses truncate around 100KB.
6. Restore appearance, close the tab.
7. Diff the new dump against this directory. A visual or computed-style
   change = a spec update: land the new fixtures and update
   `inventory.md` in the same PR, citing what moved.

## Session used

- Scrape session: `session_011duc4fgUaTKStjYmRxkuG3`
  ("Markdown and code formatting demo", repo
  `ChristopherChiechi/ABET_Course_Assessment_Tool`) — created for this
  scrape, safe to delete.
