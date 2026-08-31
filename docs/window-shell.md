# Window shell and pane layout

The Electron renderer reads the geometry below from
`assets/theme/light.toml` and renders against the measured values from
`Claude Code Images/light-view.png` (1200×805). Tokens, not hardcoded
CSS, are the source of truth; a token edit re-themes the running app
via the existing dev-mode watcher.

## Geometry (locked)

| Surface | Width | Height |
|---|---|---|
| Sidebar | 288 px | full |
| Tasks panel | 283 px | full |
| Titlebar | — | 44 px |
| Status bar | — | 33 px |
| Sidebar row | — | 26 px |
| Composer | — | 44 px |
| Pane dividers | 1 px | — |

All values live in `[app.layout]` and `[app.composer]` of
`assets/theme/light.toml`. The token file is the source of truth.

## Decision 1 — window chrome: **custom (client decorations)**

`titleBarStyle: 'hidden'` + `titleBarOverlay: true` on the
`BrowserWindow`. Suppresses Win32's painted titlebar; the renderer
draws the titlebar in HTML/CSS, the OS still owns the minimize /
maximize / close buttons in the overlay's reserved region.

This is what keeps Windows Snap Layouts and the Win11 maximize-hover
flyout working on a frameless window — the WCO maximize button is the
native one, so the OS treats hover the same way as any other app.
**Do not draw a custom maximize button.** Custom buttons in HTML
silently disable Snap Layouts (the OS detects the maximize button via
`WM_NCHITTEST` returning `HTMAXBUTTON`; an HTML button returns
`HTCLIENT`). Documented Electron limitation
(electron/electron#40706 and the related overlay-state issues
#41786/#32285/#52208/#38431).

The screenshot's left cluster (`hamburger · sidebar toggle · search ·
back · forward`) is omp-specific navigation, so it does not survive
from any standard frame. Native decorations were rejected because they
make that cluster impossible.

**Titlebar height:** WCO overlay height is set via
`titleBarOverlay: { height: 44 }` to match the measured value. CSS
pads the drag region to the same height so the custom titlebar sits
flush against the overlay's buttons.

## Decision 2 — the Cowork tab: **drop it**

Cowork is out of scope, and the tab strip would otherwise sit empty or
carry a single "Code" affordance that exists only for visual fidelity.
Both options reclaim worse space than the strip itself.

The session title moves into the transcript pane's own header (with the
`abm` chip beside it). Sidebar top actions start 42 px higher than the
screenshot's geometry because the project header no longer needs to clear
a tab strip.

If omp later needs a tabbed surface, it lives inside the transcript
pane — not the titlebar.

## Decision 3 — three-pane skeleton

`sidebar (288) | transcript (flex) | tasks (283)`, with two 1 px dividers
at `border` colour (`#e8e8e8`). CSS grid with fixed-width columns and a
flex middle.

| Pane | Width | Resizable | Collapsible | Persisted |
|---|---|---|---|---|
| Sidebar | fixed 288 px | yes — future | yes — from titlebar | yes — future |
| Transcript | flex | no (it is the flexing child) | no | n/a |
| Tasks | fixed 283 px | yes — future | yes — from its own header | yes — future |

Collapse is implemented now (titlebar toggle for sidebar, panel header
button for tasks). **Resizability and persistence are deferred.** Both
want a dev-watcher-watched preferences file analogous to the token file
— adding the watcher, the schema, and the resize drag handlers in the
scaffold would crowd out the questions it is meant to settle.

Add when: a user actually complains about a fixed 288 px sidebar.

## Decision 4 — sidebar contents

Top actions row (`+ New`, `Customize`) → project group header (`abm` with
its own `+` and sort buttons) → session rows.

**Row anatomy:** 26 px tall, `text_sm`, 7 px leading status dot, single
line that truncates with ellipsis (row height is fixed, so wrap would
break the rhythm).

**Status dot encoding:** filled `accent` (`#d97757`) when the session's
agent is running, hollow 1 px `text_muted` border otherwise. "Running"
maps onto `agent_start` / `isTerminal` (`docs/rpc-events.md` §1.1).

**Selected row:** `bg = muted` (`#edece8`), text in `text_primary`. Click
selects; selection is in-memory only.

**Project mapping:** the project group header reads `abm` (the encoded
cwd's directory name) from the session directory layout. One group per
cwd; the dev build hardcodes a single group because it has no real
sessions.

## Decision 5 — status bar

33 px tall, `secondary` surface, 1 px top divider. Three regions left to
right:

### Bottom-left — account row

`Jay · Gateway ⌄`. **Local config**, not RPC. The account label and
gateway identifier come from the user's local auth setup. Survives with
no live session.

### Bottom-right of the transcript — controls cluster

| Element | Source | Notes |
|---|---|---|
| `Bypass permissions` | local client state, echoed on `get_state` | not an RPC stream |
| `+` | local — opens the model/thinking menu | not an RPC concern |
| `GPT 5.6 Luna` | `config_update.model` (`rpc-events.md` §1.5) | `model_changed` (§1.4) carries **no** payload — must re-`get_state` after it. `config_update` is the path here. |
| `High` | `thinking_level_changed.thinkingLevel` (§1.4) | unlike `model_changed`, this one is self-sufficient |
| `●` spinner | driven by `agent_start` (`isTerminal = false`) and the matching terminal event | "**`isTerminal` is the single most important flag for the spinner**" — `rpc-events.md` §1.1 |

A `Bypass permissions` chip is rendered; switching it triggers a local
state change and re-issues the session permission on next prompt.

### Center — dev-only readout

The centre of the status bar carries `tokens ok · N reload(s)` (or the
last-good error) so a token edit is visibly applied. The real app
removes this region entirely.

## Decision 6 — composer and git strip

**Composer:** MVP. 44 px tall, 12 px radius, 1 px `composer_border`
(`#e1e1e0`), placeholder text, submit glyph on the right.

**Git strip (`abm  master   +416 −0   Commit changes`):** **deferred,
not MVP.** It needs a git integration nothing else in the MVP requires,
and the screenshot is the only signal that anyone uses it. Rendered
in the dev build as a dimmed card labelled `git strip — deferred, not
MVP` so the space it would occupy is visible in the layout.

Add when: a real user asks for in-app git status. The strip then reads
from a `simple-git` call against `<encoded-cwd>` and renders behind the
composer.

## Renderer stack (locked)

- React + TypeScript via Vite.
- `@tanstack/react-virtual` for both the transcript list and any
  long scroll region (see `docs/transcript-rendering.md` §4 for the
  virtualization contract).
- `streamdown` for assistant message bodies (see
  `docs/transcript-rendering.md` §5).
- shiki via `@streamdown/code` for syntax highlighting — lazy, on
  expand.
- Tokens via CSS custom properties generated from
  `assets/theme/light.toml` at build time; the file itself stays TOML
  and is loaded directly in dev for the hot-reload loop.
- IPC: `MessageChannelMain` for the hot transcript stream
  (renderer-side `MessagePortMain` paired with the main-process port
  that the `omp-rpc` codec feeds); `ipcRenderer.invoke` for cold
  request/response only. See `docs/research/web-stack-choice.md` §2.