# Transcript rendering spec — ticket 07

Resolves issue #1. Companion to the `transcript` prototype under
`crates/claude-omp-desktop/src/transcript/`.

## 0. Scope and verdict

The transcript pane has three jobs: render messages from `omp --mode rpc-ui`
at conversation scale (10⁴–10⁵ lines), keep up with streaming at token
cadence, and let the user read what was said. The motivating complaint was
Electron-harness lag on long conversations — this pane is the test of
whether GPUI bought us anything.

This ticket ships:

1. A spec doc (this file) the next tickets cite instead of re-deciding
   layout.
2. A prototype (`crates/claude-omp-desktop/src/transcript/`) that drives the real
   streaming render path against a recorded `omp` capture. Headless runnable
   (`cargo test -p omp-desktop transcript`) without a window server.

What this ticket explicitly does **not** ship:

- A live wire to a running `omp` child. The transport layer is wired in
  ticket 10's follow-up; the prototype plays back a recorded capture so the
  render loop can be benchmarked deterministically. The capture is the
  artifact that proves the design.
- The real composer (steer/follow_up/imaging). Tickets 06 + 09 own the
  composer geometry and surface.
- Dark mode. The token system does not preclude it (ticket 05) but no dark
  tokens land here.

## 1. Pane geometry (locked from ticket 06)

The shell already reserves the pane:

| Surface | Height |
|---|---|
| Pane header | 44 px |
| Message list | flex (min width 360 px per ticket 06 §3) |
| Composer + git-strip slot | 88 px total — 34 px git strip + 10 px gap + 44 px composer (decision 6) |

Total reserved chrome: **44 px above + 88 px below = 132 px.** Issue #1
asked ticket 07 to reserve "the ~122 px" of chrome (44 header + 44
composer + 34 git strip, no gap). The implementation reserves 132 px:
the extra 10 px is a deliberate gap between the git strip and the
composer so the composer does not crowd the strip's bottom border on
resize. Without that gap, the strip and composer render flush and the
composer's `box_shadow` clips the strip's separator. **If a downstream
ticket needs the exact 122 px figure, lift the gap to 0 and remove this
paragraph.**

Total reserved chrome below the message list: **88 px**. The list itself
sizes to whatever remains. **The list's bottom padding is 0** — the
composer carries the bottom inset, and the list's overflow region ends
flush against the composer box. Adding padding on the list side double-cuts
on resize.

Horizontal: 36 px left/right inset on the message list (matches the body
copy leading in `light-view.png`; the user-bubble right alignment pushes
those bubbles toward the right edge, leaving a comfortable margin against
the pane boundary).

## 2. Message forms

Six components, all read tokens from `assets/theme/light.toml` via the
existing `Tokens` struct; nothing is hardcoded that the file could
re-theme.

### 2.1 User message

Right-aligned, tinted rounded background (`card_bg` `#f2f2f1`, 12 px
radius, `lg` from the radius scale), `text_primary`. Single-line wrapping
with the natural line-height of `mono_md` is wrong — user prose is `md`
(14/22). **Padding 8 px vertical, 12 px horizontal.** Max-width 70 % of
the list width, capped at the pane width minus the 36 px insets — long
user prompts wrap rather than overflow horizontally.

The user bubble appears as a chip; **the right-edge alignment uses
`justify_end()` on a flex row**, not absolute positioning, so the bubble
sizes to its content and the row holds the alignment.

### 2.2 Assistant prose

Left-aligned, **full available width** (no max-width), `text_primary`,
`md` type scale (14/22 from `text.md`). No background. Paragraphs
separated by one `md` line-height (`gap_22()`); the markdown renderer
inside `text_view` handles list/quote/heading hierarchy with its own
type-scale mapping.

### 2.3 Bulleted lists and bold runs

Owned by `gpui-component`'s markdown renderer (`text/format/markdown.rs`
parses via the `markdown` crate GFM mode → mdast AST → `text::node` →
`text_view`). **We do not re-implement the markdown renderer.** See §5.

### 2.4 Inline code

`TextRun` with `font_family = mono_md`, `font_size = mono_md.size`
(13 px), `background_color = inline_code_bg` (`#f2f2f1`, sourced from
`tokens.surface` — same colour as cards, intentionally — the screenshot
treats inline code and card surfaces as one visual tier). **Horizontal
padding 4 px**, vertical padding 1 px. Same renderer handles this via
the `code` node type.

### 2.5 Collapsed tool-call row

Renders as a single-line pill: **tool name in `text_primary` medium
weight**, then a short first-line summary in `text_secondary`, then a
trailing chevron glyph (`›`). Padding 6 px vertical, 10 px horizontal,
`card_bg`, `sm` radius (4 px). Whole row is one clickable `div()` with
`.id("tool-{toolCallId}")` and `.on_click(...)`.

The summary is the first line of the tool's input args when string-coercible,
or the tool's description otherwise. Examples drawn from real captures:

- `Bash` → `git diff --stat`
- `Read` → `crates/omp-rpc/src/lib.rs`
- `Grep` → `fn apply` (pattern)
- `Task` → `Trace waveform pipeline`

For `Bash` specifically: the summary is the **first non-whitespace token of
the command** (the verb), matching `light-view.png`'s `Bash   git status ›`
shape. For file-reading tools, the first path-like argument. For Task
tools (subagent spawns), the task title. See §3 for the expanded state.

### 2.6 Run-summary line

`Ran 4 agents ›`, `Read 12 files ›`, etc. — surfaced as a stand-alone
div() **above** the assistant turn that triggered them, `text_muted`,
`text_sm`, 8 px top padding so it visually attaches to the assistant
message rather than the prior one. Not a tool row (no `toolCallId`), so
not collapsible. This is the "ephemeral turn metadata" surface and is
distinct from per-tool-call rows.

The MVP does not derive run summaries from a single event; they come from
the **trailing assistant message's text content** when it opens with the
prefix `Ran <N> <verb>` (matches ompweb's heuristic). Anything else
shows nothing — false negatives are cheap, false positives would render
gibberish.

## 3. Collapsed vs expanded tool calls

**Decision: per-call collapse state, no global toggle.** Each row holds
its own `expanded: bool`. Initial state collapsed. The toggle is the row
itself — click to expand, click the summary header to collapse. The
expanded body shows:

- For `Bash` and similar: the full command in a `code` block (`mono_md`,
  `card_bg`), then the result below in `md` prose (markdown-rendered).
- For `Read`-class tools: a small header (path, line count) then the
  file content in a `code` block. **No syntax highlighting in MVP** —
  the highlighter cost is non-trivial (see §5.3) and the screenshot
  shows plain text in the collapsed one-liners.
- For `Grep` / `Glob`: pattern header, then result list (one result per
  line, file path muted, matched text primary).
- For `Task`: the agent name + task title in a header, then a "View
  transcript" link in `text_link` that opens the transcript dialog
  (owned by ticket 08; here it renders as a non-functional placeholder
  link until that ticket lands).

Expansion animates with `cx.animate()` over 120 ms — collapse is
instant (no animation). Why: expansion can move later content down many
hundred pixels and a 120 ms tween is enough to track without
disorientation; collapse can be abrupt because the user's gaze is
already on the row.

**No global toggle.** A "expand all" command sounds useful until you
expand a 50-file `Read` chain — then the rest of the conversation is
pushed off-screen and the user has to scroll past it. Per-call keeps
each row cheap. Add a global toggle when somebody asks for it.

## 4. Virtualization and streaming

This is the load-bearing part. The decision is driven by what the **crate
versions we actually ship** expose, not by ticket 01's pre-revision
findings.

### 4.1 What we have

`gpui = "0.2.2"` (crates.io, per ticket 10's resolution of ticket 01's
broken `[patch]`). Reading
`~/.cargo/registry/src/.../gpui-0.2.2/src/elements/list.rs` directly:

- `pub fn list(...)` exists, with `ListState::new(count, alignment, overdraw)`.
- `ListAlignment::{Top, Bottom}` exists.
- `ListState::scroll_to_reveal_item(ix)` exists.
- **`ListState::remeasure_items(range)` does not exist.**
- **`FollowMode::Tail` does not exist.**
- **`scroll_to_end()` does not exist.** `scroll_to_item(ix,
  ScrollStrategy::Top)` exists instead.
- `uniform_list` exists but is fixed-height only.

`gpui-component = "0.5.1"` exposes a wrapper:

- `pub fn v_virtual_list(view, id, item_sizes: Rc<Vec<Size<Pixels>>>, render) -> VirtualList`
  — supports variable-height items but **requires the caller to pre-compute
  the size vector** and **the list itself only measures index 0** to pick
  the column width (which we don't use — vertical list, width is the pane).
- `VirtualListScrollHandle::scroll_to_bottom()` exists.
- No follow-tail mode, no auto-remeasure.

**Implication: the streaming loop is ours.** Every component in this
ticket owns the size of its row, and we update the size vector and call
`cx.notify()` when the streaming last message grows.

### 4.2 Streaming loop (the answer to ticket §3 / §4)

The transcript's source of truth is a `Vec<ChatMessage>`, mutated through
a `TranscriptModel` (one entity, owned by the pane). The render path:

1. **Apply event to model.** For `message_update.partial`: find the
   streaming message by `message.id`, **replace** its content blocks with
   `assistantMessageEvent.partial.content`. Stateless replace, not
   append. (Verifies `docs/rpc-events.md` §2's snapshot finding.)

   `assistantMessageEvent.type` distinguishes `text_start`, `text_delta`,
   `text_end`, `thinking_start`, `thinking_delta`, and `thinking_end` on the
   wire. The transcript intentionally collapses all six into one
   `Event::MessageUpdate { id, text }`: every subtype carries the same full
   `partial` snapshot, so subtype-specific rendering would not change the
   text row. `text_start` / `thinking_start` may carry an empty snapshot;
   `text_delta` / `thinking_delta` replace with the accumulated snapshot;
   `text_end` / `thinking_end` replace with the final snapshot. The outer
   `message_end` remains authoritative and settles the row. Thinking content
   is not surfaced separately in this MVP; if ticket 09 adds a thinking
   surface, it must split these subtypes before this collapse. A decoder test
   pins this rule so the discriminator cannot start affecting transcript
   order by accident.
2. **Coalesce.** Per ompweb's four-rule contract:
   - `message_update` → store as pending, schedule a flush via
     `cx.spawn` + `smol::Timer::after(16ms)` (one frame at 60 Hz; the
     GPUI analogue of `requestAnimationFrame`).
   - `message_end` → **drop** pending, cancel the timer, apply the final
     message directly.
   - Any other event type (tool, subagent, etc.) → **flush pending
     synchronously first**, then dispatch. Otherwise a
     `tool_execution_start` can render before the text that preceded it.
   - `agent_end` with `isTerminal !== false` → flush pending, clear
     streaming flag.
3. **Remeasure.** After coalesce flush, recompute the size of the
   streaming message's row. **Only that one row.** Use a `TextView`
   cached-measure path: ask the same `text_view` element for its
   intrinsic height at the current pane width via a measure closure, OR
   cache the row's last height and re-trigger GPUI's own measure pass
   with `cx.notify()`. The `Rc<Vec<Size<Pixels>>>` is `Rc<RefCell<_>>`,
   so we mutate the single entry and `cx.notify()` the pane. The list
   re-paints only that row (GPUI's element diffing handles it; the
   `ListState` pixel anchor keeps the scroll position stable).
4. **Stick-to-bottom.** The pane tracks an `is_following_tail: bool`,
   initialised `true`. On every coalesce flush, if
   `is_following_tail`, call
   `scroll_handle.scroll_to_bottom()`. On `ScrollWheel` event, if the
   new offset is **not** at the bottom (a 4 px slack band), set
   `is_following_tail = false`. A `cx.listener`-bound click on the
   "scroll-to-bottom" affordance (a 28 px round button anchored to the
   bottom-right corner, visible only when `!is_following_tail`) sets
   it back to `true` and scrolls.

The remeasure cadence: **once per coalesced flush**, which is at most
once per frame (16 ms at 60 Hz, often less because nothing is flushing
when the model is between token batches). At 49 text-deltas over ~30 s
in the recorded capture, the flush rate is well below the frame budget
even on a 60 Hz screen. **We never call `cx.notify()` per token.**

### 4.3 Scroll mechanics

- **Continuous scroll, not per-message.** The screenshot's top message is
  clipped mid-line, so a "snap to message" alignment would visibly snap.
  Smooth pixel-anchored scroll, with the list's natural snap point being
  the closest message boundary at rest.
- **Visible scrollbar on the right.** `gpui-component`'s `Scrollbar`
  (`scroll::scrollbar`) draws on top of the list, hidden when there's
  nothing to scroll, auto-hiding after 1 s of inactivity on hover-leave.
  Width 6 px, `text_muted` track, `text_secondary` thumb.
- **Slack band:** the bottom-edge detector uses a 4 px slack so the
  user can scroll a hair past the end without disengaging. Anything
  beyond that disengages.

### 4.4 Why not `pulldown-cmark` directly, why not raw `div()`s

The 06 prototype used raw `div()`s for the layout. That's still the right
call for **non-message chrome** (header, composer area) — the prototype
already does this and there's no reason to migrate. **Message bodies** are
a different problem: prose with paragraphs, lists, inline code, fenced
code, links — writing all of that in `div()` is a re-implementation we
don't need. `gpui-component`'s `text_view` already does it.

## 5. Markdown pipeline

### 5.1 Parser: the `markdown` crate via `gpui-component`

`gpui-component 0.5.1` uses the `markdown` crate
(`Cargo.lock` entry: `markdown = 1.0.0`, GFM mode via
`markdown::to_mdast(&raw, &ParseOptions::gfm())`, then `mdast` → their
`text::node` IR → `text_view` render). The crate is on crates.io,
Apache-2.0 (same as `gpui-component`), no GPL contamination.

We do not import `markdown` directly — we go through `text_view`. If a
capability the transcript needs is missing from `text_view` (e.g., a
node variant it doesn't render), we either extend `text_view` (one small
patch in `text/node.rs`) or write a 10-line custom render for that case.
No fork of `gpui-component`.

### 5.2 Subset supported in MVP

| Markdown | Supported | Notes |
|---|---|---|
| Paragraphs | yes | |
| Bold / italic | yes | inline |
| Inline code | yes | `code` span; `mono_md` |
| Bulleted / numbered lists | yes | |
| Headings (h1–h6) | yes | type-scale mapping done by `text_view` |
| Links | yes | renders as `text_link` colour; no click-through in MVP |
| Fenced code blocks | yes | **no syntax highlighting in MVP** (see §5.3) |
| Blockquotes | yes | `text_secondary` left border |
| Tables | yes | GFM; basic styling only |
| Task lists | yes | GFM |
| Images | **no** | the agent transcript doesn't carry them; out of scope |
| HTML inline | **no** | we strip; agent never emits it |

A test in `transcript/markdown.rs` parses a fixture string covering the
supported subset and asserts the resulting `text_view` element renders
without panic.

### 5.3 Syntax highlighting

**Decision: deferred.** The transcript pane's MVP shows fenced code
blocks as `mono_md` plain text with `card_bg`. Reasons:

- The highlighter cost is real. `gpui-component` integrates tree-sitter
  via `crate::highlighter`, which parses on first paint. For the
  streaming-last-message case, we'd be re-highlighting on every flush —
  even with caching, that's a measurable cost.
- The screenshot's collapsed tool rows show **plain text in the
  summary**, not highlighted code. The expanded code blocks in the
  screenshot are also unhighlighted (the screenshot has no large code
  blocks expanded for us to measure against).
- ompweb's `syntax-highlight.ts` is large (~600 LoC) and runs at agent-
  emit time, not at every re-render. Without that, highlighting on
  every coalesce flush risks the 60 fps budget.

When we add it: **lazy, on expand.** Fenced code is rendered plain until
the surrounding tool row expands; on expand, run the highlighter once and
cache the result keyed by `(language, content_hash)`. The streaming last
message is never highlighted in real time.

### 5.4 Restyling against the token file

`gpui-component`'s `text_view` reads colours via `cx.theme().text_*`,
which is populated from `[semantic]` of `light.toml` on token-file load
(ticket 05). The mapping is mechanical — `text_view`'s default colours
land close to ours (`text_primary` ≈ `text.foreground`,
`text_secondary` ≈ `text.muted_foreground`), and the type-scale token
`mono_md` flows through. **Where the default differs**, override
explicitly on the `text_view` builder — that's a one-line
`.text_color(rgb(tokens.text_primary))` and matches the prototype's
"raw `div()` for chrome, library for content" pattern.

## 6. Text selection and copy

### 6.1 Decision: per-message, not cross-message

`gpui-component 0.5.1` has **no `TextSelectionScope`**. Reading
`text/window_selection.rs` — it doesn't exist in this release.
`gpui-component`'s ticket 02 description was wrong on this point: the
cross-element selection code lives in **Zed's `ui` crate** (GPL), not
in `gpui-component`. We do not have it.

Three options were considered:

1. **Build our own cross-element scope on top of `EntityInputHandler`
   + `TextLayout` geometry.** Roughly +600–1000 LoC of state plumbing,
   per-frame cursor math, and click-out-of-message boundary detection.
   Largest single scope addition in the ticket.
2. **Defer entirely — spec only, no implementation.** Ship the
   prototype with no cross-message selection; document the missing
   capability and the contract any future implementation would have
   to satisfy.
3. **Per-message selection only.** Use `gpui-component`'s built-in
   `.selectable(true)` on each `text_view`. Selection works *inside* a
   message; cross-message copy is done by selecting one message at a
   time and clicking the next message's copy button, OR by manual
   Ctrl+C on each selection. Add a per-message "copy all" affordance
   in the message header (small `⎘` glyph, top-right of assistant
   bubbles, hidden until hover; always visible on user bubbles).

**Chosen: option 3.** Rationale: the real use case for cross-message
copy is "I want to grab the whole conversation" — and the transcript
already exposes a "select all" via Ctrl+A on the focused pane (since
each message is its own selectable region, Ctrl+A on a focused
`text_view` selects only within that view; users can shift-click into
the next message and continue, but the boundaries are not joined).
The MVP does not block on a single ergonomic shortcut. If usage
demands real cross-message selection, the path is open: implement a
`TextSelectionScope` analogue against `EntityInputHandler` and
`TextLayout::index_for_position`, ~600 LoC, deferred until requested.

### 6.2 Per-message copy button

Every assistant message has a small `�` button in its top-right corner,
visible on hover (opacity 0 → 1 over 100 ms). User messages always show
it (user bubbles are short and the affordance is cheap). Click copies
the message's plain text to clipboard. No "copy as markdown" in MVP.

## 7. History loading

### 7.1 Initial load

On session open:

1. Issue `get_messages_page` with no cursor, limit 256.
2. Render a single skeleton row ("Loading transcript…") centred, 28 px
   tall, `text_muted`, until the response arrives.
3. On response: replace skeleton with the page, render normally. If
   `nextCursor` is present, set the list's `item_count` to the page
   count (don't pre-allocate for unknown total — `nextCursor` is the
   truth).
4. Trigger the next page request (`get_messages_page { cursor,
   limit: 256 }`) **on scroll within 200 px of the top edge**, not
   eagerly. Streaming is the hot path; history paging is cold.
5. On `session_busy` error (the session is streaming or compacting):
   don't retry now; **retry on `agent_end` with `isTerminal !== false`**
   or `auto_compaction_end`. The transcript shows the loaded page;
   subsequent pages wait.
6. On `stale_cursor` error: discard the in-flight page and restart from
   no cursor (the session changed under us; `docs/rpc-events.md` §5.2).

### 7.2 Scroll-back behaviour

While paging:

- The in-flight page request is invisible to the user (no spinner, no
  "loading" overlay). The skeleton row at top is only for the *first*
  load.
- If the user scrolls into the not-yet-loaded region, they see the
  bottom of the loaded page; the list's `item_count` does not extend
  into the un-loaded region until the page arrives. This keeps the
  list consistent and avoids blank-row flashes.
- A short "Load earlier messages…" pill at the very top of the list
  (above the oldest loaded message) offers manual paging. Visible only
  when `nextCursor` is set. Clicking it triggers the next page request;
  on success the pill moves up to the new top.

### 7.3 Live updates during paging

A `message_start` / `message_end` arriving mid-paging gets applied to
the model normally — the page request is for **history**, not the
current cursor. The streaming-last-message handling is independent of
paging.

If the session is streaming and we try to page, we get `session_busy`
(per `docs/rpc-events.md` §5.2). We surface a quiet inline message:
"Transcript locked while streaming — try again when the turn ends" in
`text_muted` next to the "Load earlier" pill, replacing it.

## 8. Source-of-truth inputs (citations)

| Ticket | Finding | Used in |
|---|---|---|
| 01 → 10 | `gpui = "0.2.2"` from crates.io (not the v1.17.2 git pin) | §4.1, the entire remeasure story |
| 02 | `gpui-component` adopted; their `text_view` is our markdown | §5 |
| 03 | `message_update.partial` is the full snapshot — replace, not append | §4.2 |
| 03 | Four-rule ordering contract for `message_update` coalescer | §4.2 |
| 03 | Three completion signals: `message_end` / `assistantMessageEvent.type ∈ {done, error}` / `agent_end && isTerminal !== false` | §4.2, §7 |
| 03 | Tool results arrive raw — syntax highlighting, diff views, file links are ours | §2.5, §5.3 |
| 03 | `get_messages_page` codes: `session_busy`, `stale_cursor` | §7 |
| 05 | Token file authoritative; `mono_md` type scale; `inline_code_bg` = `surface` colour | §2.4, §5.4 |
| 06 decision 2 | Session title lives in the pane's header | §1 |
| 06 decision 6 | Composer + git strip = 88 px reserved below the list | §1 |
| 06 §3 | Pane `min_w(px(360.))` — the list's hard floor | §1 |

## 9. Corrected vs ticket 01/02/03 premises

Three of this ticket's "resolved inputs" turn out to need correction
now that we're building against the crates we actually ship:

1. **`ListState::remeasure_items` and `FollowMode::Tail` do not exist in
   `gpui = "0.2.2"`.** Ticket 01 read those APIs from the `v1.17.2` git
   rev. Ticket 10 overturned the pin. The streaming remeasure and the
   stick-to-bottom loop are ours (§4.2).
2. **No `TextSelectionScope` in `gpui-component 0.5.1`.** Ticket 02
   cited `ui/src/text/window_selection.rs` for cross-element selection;
   that file lives in Zed's GPL `ui` crate, not in `gpui-component`. We
   do per-message selection (§6).
3. **`gpui-component`'s markdown support uses the `markdown` crate, not
   `pulldown-cmark`.** The crate is `markdown = 1.0.0`, GFM via
   `markdown::to_mdast(...).gfm()`. Same conclusion (use theirs), but
   the parser name is different.

These are recorded so the next tickets don't re-derive them.

## 10. Prototype

`crates/claude-omp-desktop/src/transcript/` ships five modules, 69 tests green
across 4 suites (`cargo test -p omp-desktop`):

- `model.rs` — `TranscriptModel`, `ChatMessage`, `Coalescer`, and the
  NDJSON→`Event` decoder. Pure data, no GPUI. Enforces the four-rule
  ordering contract and the snapshot-replace semantics.
- `sizing.rs` — `SizeCache`: the `Rc<Vec<Size<Pixels>>>` handed to
  `v_virtual_list`, with `sync()` choosing between a one-row update (the
  streaming tail) and a full rebuild (row inserted/removed/resized).
- `pane.rs` — `TranscriptPane`: the projection. Owns follow-tail state,
  the scroll handle, tool-row toggling, and the per-row element builders.
- `fixture.rs` — replays the recorded capture through the model, with a
  simulated frame clock.
- `main_wiring.rs` — demo-only: drives the capture into the mounted pane
  at a watchable rate so `cargo run` shows a streaming transcript.
  Deleting it is a one-file change when the real RPC transport lands.

The fixture is `assets/fixtures/streaming-capture.ndjson`: a **real**
recording from `omp 18.x`, produced by piping `negotiate_protocol` +
`get_state` + a `prompt` into a live `omp --mode rpc-ui` process. 91
frames — 1 `ready`, 3 responses, 1 `agent_start`, 49
`message_update.text_delta`, 1 `agent_end`, plus 21 `extension_ui_request`
and other extension traffic left in deliberately (they must decode to
`Event::Other` without disturbing the transcript, and a test asserts it).

### 10.1 What the prototype proves

Empirically, against the real capture:

- `partial.content[0].text` grows monotonically 1 → 177 chars across the
  49 deltas — the snapshot finding from ticket 03, confirmed on the wire
  rather than taken on faith.
- Final rendered text equals the **last** snapshot, not the sum of the
  deltas (`snapshot_replace_does_not_duplicate_text`). This is the test
  that fails loudly if anyone "optimises" the model into a delta-append.
- A streaming turn drives `SizeCache::tail_updates` and leaves
  `rebuilds` untouched — the whole point of §4.2.
- Coalescing collapses the token stream: applied updates are far fewer
  than deltas received.

### 10.2 The pane is mounted

`shell.rs` constructs the pane lazily through `transcript_view()`, which
memoizes the entity and returns the same handle on subsequent calls —
exactly the pattern `gpui::Entity::new` calls "shared ownership". The
pane's row builders (`TranscriptPane::render_row`) are the only thing
`v_virtual_list`'s callback calls, and they were already written and
public for this.

The 16 ms flush timer is `TranscriptPane::spawn_frame_flush`. It owns a
`Task` handle that is replaced on every `Render::render` so a flush
never races a paint on a stale `&mut App`. Per-call expansion state lives
in `TranscriptModel::toggle_tool`, which the pane wires up in
`on_tool_click` and the row builder hands an `Entity<Self>` handle to —
the closure signature inside `v_virtual_list` does not hand us a
`Context<Self>`, so the handle is stashed on the entity on first render.

Markdown bodies render via `TextView::markdown` against the `markdown`
crate's mdast pipeline. The `code` / `pre` styling is whatever
`gpui-component` ships; the pane does not touch it.

### 10.3 The streaming-cost benchmark

The benchmark the project stakes itself on lives in
`crates/claude-omp-desktop/tests/streaming-cost.rs`. It is headless, measures
the *model + sizing* cost of one coalesced flush, and asserts three
things:

1. **Scaling.** Per-flush cost must not grow with transcript length.
   500× more rows must produce ≪ 500× more work, with a 10× headroom for
   cache effects; in practice the measured ratio is **1.00×** — flat.
2. **Absolute.** A 50k-row transcript must leave the frame budget almost
   free for paint. Worst observed flush is **1.6 µs** of a 16.667 ms
   budget.
3. **Mechanism.** A streaming turn re-measures only the tail row —
   `SizeCache::tail_updates` ticks once per flush,
   `SizeCache::rebuilds` stays at zero. The assertion names the cause
   directly, so a regression to the wrong path names itself.

What it does not measure is GPU paint time, which needs a window and a
swapchain. Confirming frame time end to end still needs the interactive
check this benchmark is meant to inform.

### 10.4 Findings from building it

The first version of the replay harness had no frame clock, and the
streaming path silently never ran: the coalescer holds every
`message_update` as pending (rule 1) and `message_end` then drops the last
one (rule 2), so the entire turn landed in a single settle with
`tail_updates == 0`. The final text was still correct — that is the
snapshot property working — which is exactly what makes it a dangerous
false negative.

**A UI that never redraws produces a correct transcript and zero
streaming.** The frame clock is not a performance detail, it is what makes
streaming visible at all. `without_a_frame_clock_the_turn_lands_in_one_settle`
pins this so the next person doesn't rediscover it.

### 10.5 Findings from the benchmark

The benchmark the project stakes itself on found two real O(n)-per-flush
bugs before it could pass. Both lived in `TranscriptModel`; both were
invisible to the correctness tests, because correctness tests care about
the *result* of `apply`, not how many instructions the result cost.

1. **`streaming_index()` linear-scanned** for the streaming row on every
   flush. On a 50k-row transcript this was the dominant per-frame cost
   — 85.7× cost for 500× the rows. Fixed by maintaining a
   `streaming_idx: Option<usize>` cache in the model and updating it in
   `upsert_text` (the one chokepoint where a row's `streaming` flag
   changes) plus the `AgentEnd` arm (the cold path, one scan per turn).
2. **`upsert_text` linear-scanned by id** on every `MessageUpdate`. The
   streaming row's id is stable across a turn, so when
   `streaming_idx` is `Some(ix)` the update path takes an O(1) branch
   keyed off the cache before touching the message vector.

The lesson is structural, not coincidental: the spec argues for O(1)
per flush (§4.2 step 3, "exactly this row"), and the spec was right.
The benchmark is what stops a future change from quietly re-introducing
a scan. With both fixes, per-flush cost is **1.00× across 100 → 50,000
rows** — flat, the algorithmic property §4.2 promises.

## 11. Acceptance

Done in this ticket:

1. ✅ `cargo test -p omp-desktop` green — **69 tests across 4 suites**,
   of which 35 are the unit tests in `transcript/model.rs` and
   `transcript/sizing.rs` and the streaming-cost benchmark is the 4th.
   Coverage: snapshot-replace, all four coalescer rules, the
   `isTerminal` guard, one-row-vs-rebuild sizing, tool summary shapes,
   collapse/expand heights, follow-tail engage/disengage and the slack
   band, resize behaviour, malformed-frame tolerance, and the
   flat-with-transcript-length streaming-cost claim.
2. ✅ Real capture recorded and checked in
   (`assets/fixtures/streaming-capture.ndjson`).
3. ✅ Spec written (this file), with the three corrected premises in §9
   recorded so tickets 08 and 09 don't re-derive them.
4. ✅ The pane mounted in `shell.rs` with markdown bodies via
   `TextView::markdown` and the 16 ms flush timer (§10.2).
5. ✅ The streaming-cost benchmark ticket 10 asked for
   (`tests/streaming-cost.rs`): per-flush cost is **flat** across
   100 → 50,000 rows (1.00× cost for 500× rows), worst flush on a 50k
   transcript is **1.6 µs** of a 16.667 ms frame budget, and the
   mechanism assertion pins `tail_updates`/`rebuilds` so a regression
   names its own cause. The benchmark found and forced the fix for two
   real O(n)-per-flush bugs in `TranscriptModel` (§10.5); without it
   those would have shipped.

Still open, and honestly out of reach headlessly:

6. ⬜ **GPU paint time at 60 fps.** The benchmark measures the model and
   sizing cost — the only part that scales with transcript length. Paint
   needs a window and a swapchain, and touches only the rows actually on
   screen, so its cost is a function of viewport size rather than
   transcript length. The complete claim is "flush cost is flat (proven)
   **and** visible-row count is bounded by the viewport (structural, from
   `v_virtual_list`)". Confirming end-to-end frame time still wants an
   interactive check against the mounted pane — `cargo run -p omp-desktop`
   replays the real capture for exactly that purpose.

Tickets 08 and 09 cite this file by section.
