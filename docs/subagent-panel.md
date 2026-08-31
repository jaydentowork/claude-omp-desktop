# Subagent / background-tasks panel — ticket 08

Resolves issue #2. Companion to the right-hand panel already mounted by
ticket 06's prototype (`crates/claude-omp-desktop/src/shell.rs: tasks_panel`).
The 06 prototype renders the *geometry* correctly against
`Claude Code Images/subagent-views.png`; this ticket settles *behaviour*
and data binding. Anything in here that contradicts what the 06 fixture
visually shows is wrong — fix the spec, not the screenshot.

## 0. Scope and verdict

The panel has one job: surface the set of background subagents the
session has spawned and let the user open the transcript of any one of
them. The motivating claim for this whole project is that GPUI does not
lag on long-running UI; the panel is the second test of that (the first
is ticket 07's transcript streaming benchmark). A naive per-frame
re-render of the whole panel on every `subagent_progress` frame would be
the same lag pattern the project exists to fix — the spec treats live
counter updates as the load-bearing design question and answers them
explicitly.

This ticket ships:

1. A spec doc (this file) that tickets 09 (model/thinking switcher) and
   the transport-layer follow-up cite for subagent wiring.
2. The data-binding changes that turn the 06 fixture panel into a live
   view of `RpcSubagentRegistry`. Hardcoded cards come out; the
   `AgentProgress` counter fields wire up.

This ticket explicitly does **not** ship:

- A live wire to a running `omp` child. Transport wiring lands in
  ticket 10's follow-up; the panel connects through the same registry
  the rest of the app does. Until then the panel renders from a
  recorded capture analogous to ticket 07's.
- Resizable panel width or width persistence. Window-shell decision 3
  defers both. If users want it, a follow-up ticket owns the
  preferences file alongside the sidebar resize.
- Panel-tile subagent transcript sharing. The transcript dialog
  reuses the `transcript` module's renderer (`v_virtual_list` + size
  cache), not a fresh renderer; see §4.

## 1. Data source — `progress`, not `events`

Subscribe at `set_subagent_subscription { level: "progress" }`. The
six numeric fields the cards show (`durationMs`, `tokens`, `toolCount`,
`cost`, `currentTool`, `contextTokens`) all live in
`AgentProgress` and arrive only via `subagent_progress`
(`docs/rpc-events.md` §3.3). `"events"` adds raw child transcript
spillover that the dialog covers more cheaply by polling
`get_subagent_messages`. ompweb subscribes at `"events"`; we don't
have to.

Two frame types are enough:

| Frame | Used for |
|---|---|
| `subagent_lifecycle` | Identity (id, agent, description), terminal status (`completed`/`failed`/`aborted`), `sessionFile`, `parentToolCallId`, `index`. **No counters here.** |
| `subagent_progress` | Every numeric counter the cards show. `subagentProgress` payload carries `AgentProgress`. |

`subagent_event` is **not subscribed**. The dialog reads its own agent
via `get_subagent_messages` (`subagentId` + `fromByte`); see §4.

The protocol keeps its internal `#subagents` map current regardless of
the subscription level check, but only the *forwarding* of progress
frames is gated, so `get_subagents` returns a roster even at `"off"`.
At app start we send `get_subagents` once to seed the panel before any
spawned agent's first progress frame arrives, then switch to forwarding
and treat the subscription as authoritative.

`set_subagent_subscription` is wrapped in a catch: builds older than the
command's introduction degrade to "no subagent info" rather than
failing startup (`docs/rpc-events.md` §3.1, §6).

## 2. Card states — `pending | running | completed | failed | aborted`

`AgentProgress.status` carries five values; the protocol's `started`
lifecycle status maps to progress `running`. We render all five:

| Status | Card label | Description line | Metadata line |
|---|---|---|---|
| `pending` | "Queued" | `task` (truncated) | — |
| `running` | "Agent" + elapsed `55s` | `task` (truncated) | — |
| `completed` | "Agent" + "Completed" | `task` (truncated) | `67.1k tokens · 8 tool uses` + `View transcript` |
| `failed` | "Agent" + "Failed" | `task` (truncated) | `View transcript` only |
| `aborted` | "Agent" + "Aborted" | `task` (truncated) | `View transcript` only |

The screenshots show three (running, completed, failed). The other two
fall out of the same code path but only show in practice for users who
hit them; the absence from the screenshots is a sampling accident, not
a design choice. Aborted cards are identical visually to Failed — they
catch the same "did something go wrong?" question.

Status colour: ticket 05 marks this as unverified (`Failed` cards in the
screenshot use the same muted tier as everything else; no error-red
appears in the source image). Until a real failure is measured, **all
status text is rendered in `text_muted`** — the screenshot's evidence.
When the next failure screenshot arrives, measure and add a token; the
change is one line in `assets/theme/light.toml`.

Card title text uses `text_muted` (per ticket 05's measurement), not
`text_primary`. The "title" in the screenshot's visual hierarchy is the
agent name; the row above it (agent name in `text_primary` in the
ticket-07 transcript design) is what users read first. The 06 fixture
gets this wrong (it uses `text_primary` for task title); ticket 08
fixes both colour tiers.

## 3. Grouping and ordering

Two groups, in this order, both rendered above-the-fold when present:

1. **Running.** Every row where `status ∈ {pending, running}`. Newest
   first within the group, keyed by `subagent_lifecycle.started` ms
   (or first `subagent_progress` if no lifecycle frame has arrived
   yet — defensive).
2. **Finished `N ⌄`.** Every row whose status has reached a terminal
   state (`completed` | `failed` | `aborted`). Newest first within
   the group, keyed by `terminalMs` (the time the terminal
   `subagent_lifecycle` frame arrived). The header reads `Finished N`
   where N is the visible-card count.

Sorting within group uses the time the row *entered* that group, not
its `index` (which is monotonic but doesn't reflect reality — `index`
is set at allocation, not at spawn).

`get_subagents` DELETES finished entries from the server's registry.
Our model retains them: `subagent_lifecycle` with a terminal status
mutates the row's group from Running to Finished in place. Without
this, the panel would empty out on every finished agent — exactly the
bug the screenshots show *not* happening.

**Survives a restart:** no. Finished rows are in-memory only. Restart
starts the panel at empty (or seeded from `get_subagents` snapshot,
which excludes finished). This matches ompweb's behaviour and avoids
shipping a preferences schema ticket 08 doesn't otherwise need. If
users complain, a follow-up owns the persistence file.

**Collapsed state of the Finished group:** in-memory only, lost on
restart. No persistence. Same justification.

**`Clear` action:** removes finished rows from the in-memory model.
Running rows are untouched. `Clear` does not need server cooperation —
the rows live client-side. There is no `delete_finished_subagents`
RPC.

## 4. Transcript dialog

A modal dialog keyed by `subagentId` (not `sessionFile` — the registry
resolves `subagentId` even after the agent finishes, while raw
`sessionFile` paths are only accepted if the registry has seen the
exact string, which makes them fragile after restart).

**Reuses `crates/claude-omp-desktop/src/transcript/`** for rendering. The
transcript module's job is "render messages from a session at scale with
60 fps streaming". Subagent transcripts are session transcripts — the
exact same shape. The dialog owns a `TranscriptPane` whose backing
source is a subagent-specific message-fetch loop; the render path is
shared, including the size cache, the stick-to-bottom band, and the
batch-and-settle flush cadence.

Read loop (from `docs/rpc-events.md` §3.4, restated for clarity):

1. Open with `{subagentId}`. No `fromByte` → returns the full transcript
   in one response.
2. Render the returned `messages`. Store `nextByte`.
3. Poll `get_subagent_messages { subagentId, fromByte: nextByte }` at
   250 ms cadence. Cheap: a poll that returns `nextByte === fromByte`
   with empty `messages` is normal, not an error.
4. On `reset: true`, discard accumulated state and re-render from the
   returned messages. The session file rotated under us.
5. While the row's status is `running`, keep polling for live tail.
   On terminal status, take one final poll to drain the last frames
   and stop the poller.

Live-streaming while running, freeze on terminal. Yes the dialog
*could* take `"events"` and avoid polling — but that adds a second
subscription path and complicates the dialog's lifetime. The polling
loop is the same one ticket 07's transcript uses, in spirit, and the
cost is one cheap RPC every 250 ms per open dialog.

Error handling: `get_subagent_messages` may throw
`"Unknown subagent or session file unavailable"` or
`"Subagent event bus unavailable"`. Both surface to the dialog as a
dismissable error state. The dialog does **not** retry automatically;
the user closes it.

Multiple dialogs: yes. Each dialog owns its own poller and its own
pane. Two open dialogs for the same `subagentId` are an edge case
the spec doesn't anticipate (no user-visible reason to want this);
we don't guard against it — last poller wins, both render the same
data.

## 5. Panel lifecycle

- **No spawned agents:** the panel mounts in its empty state with no
  cards. The title and `Finished 0 ⌄` (or, when there are no finished,
  no Finished row at all) are rendered, the cards div is empty. The
  panel is **always visible** — it does not auto-open on first spawn,
  because users who never spawn subagents don't see an empty bar on
  screen.
- **First spawn:** the Running group appears in place. Existing
  finished rows (if any) stay above it. No animation, no toast.
  The collapse state is preserved — if the user had the panel hidden,
  it stays hidden.
- **Restart:** panel is collapsed=hidden if the user collapsed it last
  time (no persistence, this is process-local for the current session
  only — see §3); empty otherwise; seeded from `get_subagents` on
  start.

The 06 prototype already implements the empty state by accident
(`TASKS` is empty at startup with the fixture layout). The real panel
behaves the same way minus the hardcoded data.

## 6. Live counters — the load-bearing question

`subagent_progress` arrives at provider cadence — for a long-running
agent emitting tool calls it's tens of frames per second. A naive
panel-level re-render would, at minimum, recompute every visible card's
text layout every frame and at worst recurse into GPUI's `cx.notify()`
chain. The project exists because that pattern is what we're explicitly
not doing.

**Update strategy.** Per-card, not per-panel. Each card owns its own
`AgentProgress` snapshot; `subagent_progress` payloads update only the
matching `id`'s card's snapshot and notify that card entity, not the
panel. The panel entity's `notify()` only fires on group membership
changes (lifecycle frames: a card moves groups, a card enters, a card
leaves via Clear). The diff is:

- Per-frame cost of a `subagent_progress` payload: O(1) — touch one
  card's snapshot, notify one entity.
- Per-frame cost of a `subagent_lifecycle` payload: O(Running ∪
  Finished touched rows, O(1) amortised) — typically one card moves
  groups or one card leaves via Clear.

The card-level notify cascades through GPUI's normal invalidation; if
GPUI's own invalidation batching is insufficient at provider cadence,
we drop update cadence to a windowed 8 Hz (125 ms) coalesce. The
benchmark for this is the same shape as ticket 07's streaming-cost
test: `cargo test --release --test subagent-panel-cost -- --nocapture`
measures per-flush cost at 1/2/4/8/16/30 Hz against a fixture that
emits one progress update per simulated tick.

**Elapsed-time ticker.** `durationMs` is server-side; we don't compute
it. But the elapsed-time display (`55s`, `34s`) needs to tick visually
even between progress frames. Two options considered:

- (a) Per-card 1 Hz `Timer::after(1s)` in GPUI. Costs: O(N) timers,
  one notify per card per second. Acceptable up to ~10 cards, painful
  at 100.
- (b) Single 1 Hz timer at the panel level that mutates only the
  elapsed-time `SharedString` on each card. Costs: O(1) timer, O(N)
  string writes per second.

(b) is the right answer — one timer, one channel pump, fan-out writes.
At 10 cards this is irrelevant; at 100 it's the difference between
fine and sluggish.

The ticker is **only mounted while at least one card is in the Running
group**. When all running rows finish (or on startup with no rows), the
timer task exits. This is what keeps a hidden panel's overhead at
zero.

**Hard ceiling on this approach:** at > ~10 running agents the 1 Hz
elapsed-time refresh becomes a GPUI text-layout storm. The current
panel won't hit that — ticket 09's switcher-and-thinking panel is the
only thing expected to push counts that high, and even there 10 is a
generous upper bound. If a future ticket hits it, the fix is per-card
elapsed-time caching (compute elapsed locally from `currentToolStartMs`
+ an agent-start anchor, render once per visibility-driven resync, not
per second). **ponytail:** windowed per-card invalidation. Add when
>10 simultaneous cards becomes a real workload.

## 7. Data model

```rust
struct PanelRow {
    id: AgentId,
    agent_name: SharedString,
    task: SharedString,            // truncated for display
    description: Option<SharedString>,
    status: Status,                // mirrors AgentProgress.status
    last_progress: Option<AgentProgress>, // None until first progress frame
    started_ms: u64,               // when running group entered
    terminal_ms: Option<u64>,      // set when moved to finished group
    session_file: Option<String>,  // feeds transcript dialog
}

enum Status { Pending, Running, Completed, Failed, Aborted }
```

A panel owns `Vec<PanelRow>` plus a `BTreeMap<AgentId, usize>` index,
rebuilt on every membership change. The Finished group's "newest first"
ordering is a sort by `terminal_ms` at every membership change; it
runs on the small Vec, so cost is amortised to nothing.

The 06 prototype's `Task` fixture and `TASKS` const come out. The
hardcoded live behaviour runs from the `PanelRow` model and the
recorded capture lives under `crates/claude-omp-desktop/tests/fixtures/`.

## 8. Geometry (locked from ticket 05)

Settled by ticket 06 and ticket 05's measurement. Not re-decided here;
the spec just inherits the values the prototype already uses:

- Panel width **283 px** (`tasks_panel_width` in `light.toml`).
- Header height **44 px** (`titlebar_height`).
- Card surface: **254 px** wide, **8 px** radius, **11 px** padding
  (x and y), **4 px** inter-card gap, on `#f2f2f1` (`card_bg`) over
  `#fcfcfb` (`tasks_panel_bg`).
- Card title text in `text_muted` (`#898781`).
- "View transcript" link in `text_link` (`#184f95`).
- Cards render flat — no drop shadow.

Ticket 06 deferred panel resize + width persistence. **That deferral
extends here.** No resize handle lands; collapse only.

## 9. What this ticket does not decide

Captured so the next ticket doesn't have to re-research them:

- **Resizability / persistence.** Window-shell decision 3 defers both.
  A future preferences ticket owns the file and the resize drag
  handlers. This spec assumes fixed 283 px.
- **The `destructive` token.** Ticket 05 has the placeholder; ticket
  08 doesn't introduce a new colour. If/when the next failure
  screenshot arrives, one line in `light.toml` + one binding in
  `theme.rs` is the change.
- **Dark mode.** Out of scope. The token system supports it (ticket
  05) but no dark tokens land here.
