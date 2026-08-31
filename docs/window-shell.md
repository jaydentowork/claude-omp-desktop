# Window shell and pane layout — ticket 06

A throwaway prototype (`crates/claude-omp-desktop/src/shell.rs`) renders the
decisions below against the measured geometry from
`Claude Code Images/light-view.png` (1200×805). It opens and looks right
against the screenshot — the spec, not the artifact, is what tickets 07–09
build against.

## Geometry (locked, from ticket 05)

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
`assets/theme/light.toml`. The token file is the source of truth; a token
edit re-themes the running prototype via the existing watcher.

## Decision 1 — window chrome: **custom (client decorations)**

`WindowDecorations::Client`, with `titlebar: Some(TitlebarOptions {
appears_transparent: true, .. })` to suppress Win32's painted titlebar.
The `shell.rs` titlebar div marks its non-button area as
`WindowControlArea::Drag` and each control button as
`Min`/`Max`/`Close`. That is what keeps Windows snap layouts and the
Win11 maximize-hover flyout working on a frameless window — without
`WindowControlArea` markings, clicks in those regions are ordinary mouse
events.

The screenshot's left cluster (`hamburger · sidebar toggle · search ·
back · forward`) is omp-specific navigation, so it does not survive from
any standard frame. Native decorations were rejected because they make
that cluster impossible.

**Titlebar height delta:** `gpui-component`'s `TITLE_BAR_HEIGHT = px(34.)`
is not overridable through their `TitleBar` API, and the measured height
is 44 px. The prototype does **not** use their `TitleBar` for this reason;
the titlebar is a raw `div().h(px(t.titlebar_height))`. If a future ticket
wants `TitleBar`, the resolution is to either patch the constant locally
or extend `gpui-component` upstream — neither is done here.

## Decision 2 — the Cowork tab: **drop it**

Cowork is out of scope, and the tab strip would otherwise sit empty or
carry a single "Code" affordance that exists only for visual fidelity.
Both options reclaim worse space than the strip itself.

The session title moves into the transcript pane's own header (with the
`abm` chip beside it). Sidebar top actions start 42 px higher than the
screenshot's geometry because the project header no longer needs to clear
a tab strip.

If omp later needs a tabbed surface, the right place is `gpui-component`'s
`tab` module inside the transcript pane — not the titlebar.

## Decision 3 — three-pane skeleton

`sidebar (288) | transcript (flex) | tasks (283)`, with two 1 px dividers
at `border` colour (`#e8e8e8`).

| Pane | Width | Resizable | Collapsible | Persisted |
|---|---|---|---|---|
| Sidebar | fixed 288 px | yes — future | yes — from titlebar | yes — future |
| Transcript | flex | no (it is the flexing child) | no | n/a |
| Tasks | fixed 283 px | yes — future | yes — from its own header | yes — future |

Collapse is implemented now (titlebar toggle for sidebar, panel header
button for tasks). **Resizability and persistence are deferred.** Both
want a `notify`-watched preferences file analogous to the token file —
adding the watcher, the TOML schema, and the resize drag handlers in this
ticket would crowd out the questions it is meant to settle.

Add when: a user actually complains about a fixed 288 px sidebar. Until
then, the prototype demonstrates the fixed layout.

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
cwd; the prototype hardcodes a single group because it has no real
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

### Center — prototype-only readout

The centre of the status bar carries `tokens ok · N reload(s)` (or the
last-good error) so a token edit is visibly applied. The real app
removes this region entirely.

## Decision 6 — composer and git strip

**Composer:** MVP. 44 px tall, 12 px radius, 1 px `composer_border`
(`#e1e1e0`), placeholder text, submit glyph on the right.

**Git strip (`abm  master   +416 −0   Commit changes`):** **deferred,
not MVP.** It needs a git integration nothing else in the MVP requires,
and the screenshot is the only signal that anyone uses it. Rendered in
the prototype as a dimmed card labelled `git strip — deferred, not MVP`
so the space it would occupy is visible in the layout.

Add when: a real user asks for in-app git status. The strip then reads
from a `git2` status call against `<encoded-cwd>` and renders behind the
composer.

## What the prototype borrows from gpui-component

`gpui_component::init(cx)` is called (it sets up the icon set and the
default `Theme` that the components read). Beyond that, the prototype
intentionally uses **raw `div()` everywhere** rather than `Sidebar`,
`SidebarMenuItem`, `TitleBar`, and `StatusBar` from the library.

Why: those components read colours from `cx.theme()`, and the
`Theme::default()` is not our token values. For a measurement prototype
that would put their palette between us and the numbers we are checking.
The real app's job is to populate `cx.theme()` from `assets/theme/light.toml`
on every hot-reload — ticket 02's answer says so. The prototype skips
that mapping because it is one file's worth of work, not because the
mapping is unimportant.

When the real app starts (after ticket 10 settles the workspace), the
sidebar and titlebar should migrate to `gpui-component` and read our
tokens through `cx.theme()`. The prototype's `shell.rs` is throwaway —
its job is to make the layout decisions visible, not to be the start of
the production shell.
