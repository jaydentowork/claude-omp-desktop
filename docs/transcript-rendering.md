# Transcript rendering spec

## 0. Scope and verdict

The transcript pane has three jobs: render messages from `omp --mode rpc-ui`
at conversation scale (10⁴–10⁵ lines), keep up with streaming at token
cadence, and let the user read what was said. The motivating complaint
across omp clients has been lag on long conversations — this pane is the
project's central performance claim: **per-flush cost must stay flat as
the transcript grows.** The Rust-era benchmark proved the model side of
that claim (flat across 100 → 50,000 rows, worst flush 1.6 µs); the
Electron build must re-establish it in `npm test` (see §10).

Out of scope here: the composer (window-shell decision 6), dark mode.

## 1. Pane geometry (locked)

The shell reserves the pane:

| Surface | Height |
|---|---|
| Pane header | 44 px |
| Message list | flex (min width 360 px per window-shell §3) |
| Composer + git-strip slot | 88 px total — 34 px git strip + 10 px gap + 44 px composer (decision 6) |

Total reserved chrome: **44 px above + 88 px below = 132 px.** The
10 px gap between the git strip and composer is deliberate — without
it, the composer's shadow clips the strip's separator on resize.

**The list's bottom padding is 0** — the composer carries the bottom
inset, and the list's overflow region ends flush against the composer
box. Adding padding on the list side double-cuts on resize.

Horizontal: 36 px left/right inset on the message list (matches the body
copy leading in `light-view.png`).

## 2. Message forms

Six components, all reading tokens from the CSS custom properties
generated from `assets/theme/light.toml`; nothing hardcoded that the
token file could re-theme.

### 2.1 User message

Right-aligned, tinted rounded background (`card_bg` `#f2f2f1`, 12 px
radius), `text_primary`, `md` type scale (14/22). **Padding 8 px
vertical, 12 px horizontal.** Max-width 70 % of the list width — long
user prompts wrap rather than overflow horizontally. Right alignment
via `justify-content: flex-end` on a flex row, not absolute
positioning, so the bubble sizes to its content.

### 2.2 Assistant prose

Left-aligned, **full available width** (no max-width), `text_primary`,
`md` type scale. No background. Paragraphs separated by one `md`
line-height; the markdown renderer handles list/quote/heading hierarchy
with its own type-scale mapping.

### 2.3 Bulleted lists and bold runs

Owned by `streamdown`'s GFM pipeline (remark-gfm → React elements).
**We do not re-implement the markdown renderer.** See §5.

### 2.4 Inline code

`font-family: var(--mono)`, 13 px, `background: var(--inline-code-bg)`
(`#f2f2f1` — same colour as cards, intentionally; the screenshot treats
inline code and card surfaces as one visual tier). Horizontal padding
4 px, vertical 1 px. Styled via streamdown's `code` component override.

### 2.5 Collapsed tool-call row

Renders as a single-line pill: **tool name in `text_primary` medium
weight**, then a short first-line summary in `text_secondary`, then a
trailing chevron glyph (`›`). Padding 6 px vertical, 10 px horizontal,
`card_bg`, 4 px radius. Whole row is one clickable element keyed by
`toolCallId`.

The summary is the first line of the tool's input args when
string-coercible, or the tool's description otherwise. Examples from
real captures:

- `Bash` → `git diff --stat`
- `Read` → `src/main/omp-rpc.ts`
- `Grep` → `fn apply` (pattern)
- `Task` → `Trace waveform pipeline`

For `Bash` specifically: the summary is the **first non-whitespace token
of the command** (the verb), matching `light-view.png`'s
`Bash   git status ›` shape. For file-reading tools, the first path-like
argument. For Task tools (subagent spawns), the task title.

### 2.6 Run-summary line

`Ran 4 agents ›`, `Read 12 files ›`, etc. — a stand-alone line **above**
the assistant turn that triggered them, `text_muted`, `text_sm`, 8 px
top padding. Not a tool row (no `toolCallId`), so not collapsible.

Derived from the **trailing assistant message's text content** when it
opens with the prefix `Ran <N> <verb>` (matches ompweb's heuristic).
Anything else shows nothing — false negatives are cheap, false positives
would render gibberish.

## 3. Collapsed vs expanded tool calls

**Decision: per-call collapse state, no global toggle.** Each row holds
its own `expanded: boolean`. Initial state collapsed. The toggle is the
row itself. The expanded body shows:

- For `Bash` and similar: the full command in a code block, then the
  result below in markdown-rendered prose.
- For `Read`-class tools: a small header (path, line count) then the
  file content in a code block, syntax-highlighted lazily on expand
  (§5.3).
- For `Grep` / `Glob`: pattern header, then result list (one result per
  line, file path muted, matched text primary).
- For `Task`: the agent name + task title in a header, then a "View
  transcript" link in `text_link` that opens the subagent transcript
  dialog (`docs/subagent-panel.md` §4).

Expansion animates over 120 ms (CSS transition on height); collapse is
instant. Why: expansion can move later content down many hundred pixels
and a 120 ms tween is enough to track without disorientation; collapse
can be abrupt because the user's gaze is already on the row.

**No global toggle.** An "expand all" command sounds useful until you
expand a 50-file `Read` chain. Per-call keeps each row cheap. Add a
global toggle when somebody asks for it.

## 4. Virtualization and streaming

This is the load-bearing part.

### 4.1 Virtual list: `@tanstack/react-virtual`

The virtualizer runs in end-anchored chat mode:

- `anchorTo: 'end'` — keeps an end-pinned viewport pinned when the last
  item grows during streaming, and keeps the visible item stable when
  history pages are prepended above.
- `followOnAppend: true` — scrolls to the end after appends, but only
  if the viewport was already at the end (users who scrolled up to read
  history are not pulled down).
- `scrollEndThreshold: 4` — the 4 px slack band (§4.3).
- `directDomUpdates: true` — the streaming tail's size delta bypasses
  the React reconciler.
- Dynamic row heights via the virtualizer's `measureElement` ref;
  no precomputed size vector — measurement is the library's job now.

The official TanStack chat example
(`examples/react/chat`: `streamReply` / `prependHistory` /
`appendMessage`) is the template; see
`docs/research/web-stack-renderer-findings.md` §1 for the evidence
trail and rejected alternatives (react-virtuoso, virtua).

### 4.2 Streaming loop

The transcript's source of truth is an ordered message array, mutated
through a `TranscriptModel` (plain TypeScript, no React — it must be
testable headlessly). The render path:

1. **Apply event to model.** For `message_update.partial`: find the
   streaming message by `message.id`, **replace** its content blocks
   with `assistantMessageEvent.partial.content`. Stateless replace, not
   append. (Verifies `docs/rpc-events.md` §2's snapshot finding.)

   `assistantMessageEvent.type` distinguishes `text_start`, `text_delta`,
   `text_end`, `thinking_start`, `thinking_delta`, and `thinking_end` on
   the wire. The transcript collapses all six into one
   `MessageUpdate { id, text }`: every subtype carries the same full
   `partial` snapshot, so subtype-specific rendering would not change
   the text row. The outer `message_end` remains authoritative and
   settles the row. Thinking content is not surfaced separately in this
   MVP; if a later ticket adds a thinking surface, it must split these
   subtypes before this collapse. A decoder test pins this rule.
2. **Coalesce.** Per ompweb's four-rule contract:
   - `message_update` → store as pending, schedule a flush on the next
     animation frame (`requestAnimationFrame`, one frame at the display
     rate).
   - `message_end` → **drop** pending, cancel the scheduled flush, apply
     the final message directly.
   - Any other event type (tool, subagent, etc.) → **flush pending
     synchronously first**, then dispatch. Otherwise a
     `tool_execution_start` can render before the text that preceded it.
   - `agent_end` with `isTerminal !== false` → flush pending, clear
     streaming flag.

   Coalescing happens **twice**: once in the main process (batch decoded
   events, post one `MessagePort` message per ~16 ms window — the IPC
   batching from `docs/research/web-stack-choice.md`), and once in the
   renderer (the four rules above). The main-process batch is transport
   batching only; the four ordering rules are the renderer's.
3. **Re-render only the tail.** The streaming message is the only React
   element whose props change per flush. `React.memo` on the row
   component keyed by `(message.id, message.revision)` keeps every
   settled row's subtree frozen; the virtualizer's `measureElement`
   picks up the tail row's new height and `anchorTo: 'end'` adjusts by
   the size delta.
4. **Stick-to-bottom.** Owned by the virtualizer:
   `followOnAppend: true` + `scrollEndThreshold: 4` implement
   engage/disengage. A "scroll-to-bottom" affordance (28 px round
   button, bottom-right corner, visible only when `!isAtEnd()`) calls
   `scrollToIndex(count - 1, { align: 'end' })`.

The flush cadence: **once per animation frame at most**, often less
because nothing is flushing when the model is between token batches.
**We never trigger a React render per token.**

### 4.3 Scroll mechanics

- **Continuous scroll, not per-message.** The screenshot's top message
  is clipped mid-line, so a "snap to message" alignment would visibly
  snap.
- **Visible scrollbar on the right.** Native overlay scrollbar styled
  via CSS (`::-webkit-scrollbar`, 6 px wide, `text_muted` track,
  `text_secondary` thumb), auto-hiding per platform convention.
- **Slack band:** the bottom-edge detector uses 4 px of slack
  (`scrollEndThreshold: 4`) so the user can scroll a hair past the end
  without disengaging. Anything beyond that disengages.

## 5. Markdown pipeline

### 5.1 Renderer: `streamdown`

`streamdown` (Vercel, MIT) is a drop-in `react-markdown` replacement
built for AI streaming:

- **Block-level memoization**: only blocks whose content changed
  re-render; parsing is cached per block. This is exactly the
  "re-render only the growing tail" requirement, shipped.
- **Unterminated-block parsing** via `remend`: a streaming message with
  an unclosed fence or emphasis renders cleanly mid-stream.
- Full GFM via `remark-gfm`; `rehype-harden` safe-by-default.
- `isAnimating` disables interactivity (e.g. copy) on the
  still-streaming block.

We do not import a markdown parser directly — we go through
`streamdown`. If a capability is missing, the escape hatch is a
component override on the `Streamdown` element (per-node React
component), not a fork. Evidence trail:
`docs/research/web-stack-renderer-findings.md` §2.

### 5.2 Subset supported in MVP

| Markdown | Supported | Notes |
|---|---|---|
| Paragraphs | yes | |
| Bold / italic | yes | inline |
| Inline code | yes | `mono` face, `inline_code_bg` |
| Bulleted / numbered lists | yes | |
| Headings (h1–h6) | yes | type-scale mapping via component overrides |
| Links | yes | `text_link` colour; no click-through in MVP |
| Fenced code blocks | yes | highlighting lazy (§5.3) |
| Blockquotes | yes | `text_secondary` left border |
| Tables | yes | GFM; basic styling only |
| Task lists | yes | GFM |
| Images | **no** | the agent transcript doesn't carry them; out of scope |
| HTML inline | **no** | `rehype-harden` strips; agent never emits it |

A test parses a fixture string covering the supported subset and asserts
the render output.

### 5.3 Syntax highlighting

shiki via `@streamdown/code`, lazy: code block shells render immediately
as plain text (`mono`, `card_bg`), colours resolve when highlighting
completes. Composes with streamdown's block memoization — a closed code
block is a frozen React subtree, so the per-frame streaming cost is
restricted to the growing tail. **The streaming last message is never
highlighted in real time.**

Singleton highlighter instance, per-language lazy grammar chunks (shiki's
own perf guidance). If highlighting cost shows up in the benchmark,
shiki's worker mode is the documented escape hatch.

### 5.4 Restyling against the token file

`streamdown` output is styled via CSS custom properties generated from
`[semantic]` and `[app]` of `light.toml`. The mapping is mechanical:
`text.primary` → `--text-primary` etc. Where a streamdown default
differs, override the specific component (`components={{ p: ..., a:
... }}`) — never patch the library.

## 6. Text selection and copy

### 6.1 Decision: native selection

The DOM gives cross-element text selection for free — this was the
single hardest gap in the GPUI build (per-message selection was the best
available there) and is the clearest single win of the web stack.
Selection works across messages natively; Ctrl+A within the focused
transcript selects the visible conversation; Ctrl+C copies.

One caveat: virtualization unmounts off-screen rows, so a selection
spanning beyond the rendered window clips at the overscan boundary.
Acceptable for MVP — the visible-range selection covers the real use
case, and the per-message copy button covers "grab this one message".
If "select entire conversation" becomes a real demand, add an explicit
"Copy conversation" command that serializes from the model, not the DOM.

### 6.2 Per-message copy button

Every assistant message has a small copy button in its top-right corner,
visible on hover (opacity 0 → 1 over 100 ms). User messages always show
it. Click copies the message's plain text (from the model, not the DOM).
No "copy as markdown" in MVP.

## 7. History loading

### 7.1 Initial load

On session open:

1. Issue `get_messages_page` with no cursor, limit 256.
2. Render a single skeleton row ("Loading transcript…") centred, 28 px
   tall, `text_muted`, until the response arrives.
3. On response: replace skeleton with the page, render normally. If
   `nextCursor` is present, set the list's item count to the page
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

Prepends go through the virtualizer's `anchorTo: 'end'` mode, which
keeps the visible item stable when items are inserted above — no manual
scroll compensation.

### 7.2 Scroll-back behaviour

While paging:

- The in-flight page request is invisible to the user (no spinner, no
  "loading" overlay). The skeleton row at top is only for the *first*
  load.
- If the user scrolls into the not-yet-loaded region, they see the
  bottom of the loaded page; the item count does not extend into the
  un-loaded region until the page arrives. This keeps the list
  consistent and avoids blank-row flashes.
- A short "Load earlier messages…" pill at the very top of the list
  (above the oldest loaded message) offers manual paging. Visible only
  when `nextCursor` is set.

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

| Source | Finding | Used in |
|---|---|---|
| rpc-events §2 | `message_update.partial` is the full snapshot — replace, not append | §4.2 |
| rpc-events §2 | Four-rule ordering contract for the `message_update` coalescer | §4.2 |
| rpc-events §1.1 | Three completion signals: `message_end` / `assistantMessageEvent.type ∈ {done, error}` / `agent_end && isTerminal !== false` | §4.2, §7 |
| rpc-events §3 | Tool results arrive raw — highlighting, diff views, file links are ours | §2.5, §5.3 |
| rpc-events §5.2 | `get_messages_page` codes: `session_busy`, `stale_cursor` | §7 |
| theme-tokens | Token file authoritative; `mono` type scale; `inline_code_bg` = `surface` colour | §2.4, §5.4 |
| window-shell decision 2 | Session title lives in the pane's header | §1 |
| window-shell decision 6 | Composer + git strip = 88 px reserved below the list | §1 |
| window-shell §3 | Pane min-width 360 px — the list's hard floor | §1 |
| web-stack research | TanStack chat primitives; streamdown block memo; shiki lazy | §4.1, §5 |

## 9. Findings carried over from the GPUI build

The Rust-era prototype (archived; see `docs/research/web-stack-choice.md`)
established three findings that are stack-independent and must not be
re-derived:

1. **Snapshot-replace, not delta-append.** `partial.content[0].text`
   grows monotonically across deltas in the real capture
   (`assets/fixtures/streaming-capture.ndjson`); final text equals the
   **last** snapshot, not the sum of deltas. A test must fail loudly if
   anyone "optimises" the model into a delta-append.
2. **A UI that never flushes produces a correct transcript and zero
   streaming.** Without a frame clock, the coalescer holds every update
   pending and `message_end` settles the turn in one paint — correct
   output, invisible streaming, dangerous false negative. The replay
   harness must simulate frames.
3. **O(1) tail lookup is load-bearing.** Two real O(n)-per-flush bugs
   (linear scan for the streaming row; linear scan by id on every
   update) were invisible to correctness tests and found only by the
   cost benchmark. The model must cache the streaming row's index and
   take an O(1) branch on the hot path.

## 10. Acceptance for the Electron build

1. `TranscriptModel` + coalescer as plain TypeScript, headlessly tested:
   snapshot-replace, all four coalescer rules, the `isTerminal` guard,
   malformed-frame tolerance, and decode-equivalence against
   `assets/fixtures/streaming-capture.ndjson` (same 91 frames the Rust
   decoder was verified on: 1 `ready`, 3 responses, 1 `agent_start`,
   49 `message_update.text_delta`, 1 `agent_end`, 21+
   `extension_ui_request` and other extension traffic that must decode
   to an `Other` event without disturbing the transcript).
2. **The streaming-cost benchmark, re-established.** Headless
   (`npm test`), measuring model + coalesce cost of one flush, asserting:
   per-flush cost flat from 100 → 50,000 rows; absolute cost leaves the
   16.7 ms frame budget essentially free; the streaming turn touches
   only the tail (a counter assertion that names its own cause on
   regression). The Rust benchmark's numbers (1.00× scaling, 1.6 µs
   worst flush) are the bar.
3. What headless tests cannot cover: real paint cost at 60 fps. The
   complete claim is "flush cost is flat (proven) **and** rendered-row
   count is bounded by the viewport (structural, from the
   virtualizer)". End-to-end frame time wants an interactive check
   replaying the capture — the dev build ships a replay mode for exactly
   that purpose.