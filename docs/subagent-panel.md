# Subagent / background-tasks panel

The right-hand tasks panel. Geometry was measured against
`Claude Code Images/subagent-views.png`; this spec settles behaviour
and data binding. Anything in here that contradicts what the
screenshots visually show is wrong — fix the spec, not the screenshot.

## 0. Scope and verdict

The panel has one job: surface the set of background subagents the
session has spawned and let the user open the transcript of any one of
them. A naive panel-wide re-render on every `subagent_progress` frame
is the lag pattern this project exists to avoid — the spec treats live
counter updates as the load-bearing design question and answers them
explicitly (§6).

Out of scope:

- Resizable panel width or width persistence. Window-shell decision 3
  defers both.
- A second renderer for subagent transcripts. The transcript dialog
  reuses the transcript pane's renderer (§4).

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
fall out of the same code path; the absence from the screenshots is a
sampling accident, not a design choice. Aborted cards are identical
visually to Failed.

Status colour: the theme-tokens doc marks this as unverified (`Failed`
cards in the screenshot use the same muted tier as everything else; no
error-red appears in the source image). Until a real failure is
measured, **all status text renders in `text_muted`**. When the next
failure screenshot arrives, measure and add a token; the change is one
line in `assets/theme/light.toml`.

Card title text uses `text_muted` (per the token measurements), not
`text_primary` — the "title" in the screenshot's visual hierarchy is
the agent name.

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
which excludes finished). This matches ompweb's behaviour and avoids a
persistence schema this spec doesn't otherwise need.

**Collapsed state of the Finished group:** in-memory only, lost on
restart. Same justification.

**`Clear` action:** removes finished rows from the in-memory model.
Running rows are untouched. `Clear` does not need server cooperation —
the rows live client-side. There is no `delete_finished_subagents` RPC.

## 4. Transcript dialog

A modal dialog keyed by `subagentId` (not `sessionFile` — the registry
resolves `subagentId` even after the agent finishes, while raw
`sessionFile` paths are only accepted if the registry has seen the
exact string, which makes them fragile after restart).

**Reuses the transcript pane's renderer** (`docs/transcript-rendering.md`).
Subagent transcripts are session transcripts — the exact same shape.
The dialog owns a transcript view whose backing source is a
subagent-specific message-fetch loop; the render path is shared,
including the virtualizer config, the stick-to-bottom band, and the
coalesce/flush cadence.

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
subscription path and complicates the dialog's lifetime. The cost is
one cheap RPC every 250 ms per open dialog.

Error handling: `get_subagent_messages` may throw
`"Unknown subagent or session file unavailable"` or
`"Subagent event bus unavailable"`. Both surface to the dialog as a
dismissable error state. The dialog does **not** retry automatically;
the user closes it.

Multiple dialogs: yes. Each dialog owns its own poller and its own
view. Two open dialogs for the same `subagentId` are an edge case with
no user-visible reason to want it; we don't guard — last poller wins,
both render the same data.

## 5. Panel lifecycle

- **No spawned agents:** the panel mounts in its empty state with no
  cards. The panel is **always visible** — it does not auto-open on
  first spawn.
- **First spawn:** the Running group appears in place. Existing
  finished rows (if any) stay above it. No animation, no toast.
  If the user had the panel hidden, it stays hidden.
- **Restart:** panel collapse state is process-local for the current
  session only; empty otherwise; seeded from `get_subagents` on start.

## 6. Live counters — the load-bearing question

`subagent_progress` arrives at provider cadence — for a long-running
agent emitting tool calls it's tens of frames per second. A naive
panel-level re-render would recompute every visible card on every
frame. That pattern is what we're explicitly not doing.

**Update strategy.** Per-card, not per-panel. Each card subscribes to
its own row in the panel store (keyed by `id`); a `subagent_progress`
payload updates only the matching row, and only that card's component
re-renders (`React.memo` on the card, store selector per `id` — e.g. a
`useSyncExternalStore` selector or an atom per row). The panel
component itself re-renders only on group membership changes
(lifecycle frames: a card moves groups, enters, or leaves via Clear).

- Per-frame cost of a `subagent_progress` payload: O(1) — one store
  write, one card render.
- Per-frame cost of a `subagent_lifecycle` payload: O(1) amortised —
  typically one card moves groups.

If React's render batching is insufficient at provider cadence, drop
update cadence to a windowed 8 Hz (125 ms) coalesce in the store. The
benchmark for this is the same shape as the transcript's streaming-cost
test: a headless suite that measures per-flush store cost at
1/2/4/8/16/30 Hz against a fixture emitting one progress update per
simulated tick.

**Elapsed-time ticker.** `durationMs` is server-side; we don't compute
it. But the elapsed-time display (`55s`, `34s`) needs to tick visually
even between progress frames. Two options considered:

- (a) Per-card 1 Hz `setInterval`. Costs: O(N) timers, one render per
  card per second.
- (b) Single 1 Hz interval at the store level that writes only the
  elapsed-time string on each running row. Costs: O(1) timer, O(N)
  writes per second.

(b) is the right answer — one timer, fan-out writes. At 10 cards this
is irrelevant; at 100 it's the difference between fine and sluggish.

The ticker is **only mounted while at least one card is in the Running
group**. When all running rows finish (or on startup with no rows), the
interval clears. This keeps a quiet panel's overhead at zero.

**Hard ceiling on this approach:** at > ~10 running agents the 1 Hz
elapsed-time refresh renders N cards per second. The current panel
won't hit that. If a future ticket does, the fix is per-card local
elapsed computation (derive from `currentToolStartMs` + an agent-start
anchor, re-render on visibility resync, not per second).
**ponytail:** windowed per-card invalidation. Add when >10 simultaneous
cards becomes a real workload.

## 7. Data model

```ts
interface PanelRow {
  id: AgentId;
  agentName: string;
  task: string;                     // truncated for display
  description?: string;
  status: Status;                   // mirrors AgentProgress.status
  lastProgress?: AgentProgress;     // undefined until first progress frame
  startedMs: number;                // when running group entered
  terminalMs?: number;              // set when moved to finished group
  sessionFile?: string;             // feeds transcript dialog
}

type Status = "pending" | "running" | "completed" | "failed" | "aborted";
```

The panel store owns `PanelRow[]` plus a `Map<AgentId, number>` index,
rebuilt on every membership change. The Finished group's "newest first"
ordering is a sort by `terminalMs` at every membership change; it runs
on a small array, so cost is amortised to nothing.

## 8. Geometry (locked)

Settled by the token measurements. Not re-decided here:

- Panel width **283 px** (`tasks_panel_width` in `light.toml`).
- Header height **44 px** (`titlebar_height`).
- Card surface: **254 px** wide, **8 px** radius, **11 px** padding
  (x and y), **4 px** inter-card gap, on `#f2f2f1` (`card_bg`) over
  `#fcfcfb` (`tasks_panel_bg`).
- Card title text in `text_muted` (`#898781`).
- "View transcript" link in `text_link` (`#184f95`).
- Cards render flat — no drop shadow.

Panel resize + width persistence stay deferred (window-shell
decision 3). No resize handle lands; collapse only.

## 9. What this spec does not decide

Captured so the next ticket doesn't have to re-research them:

- **Resizability / persistence.** Window-shell decision 3 defers both.
  A future preferences ticket owns the file and the resize drag
  handlers. This spec assumes fixed 283 px.
- **The `destructive` token.** The theme file has the placeholder; no
  new colour lands here. When the next failure screenshot arrives, one
  line in `light.toml` + one CSS variable binding is the change.
- **Dark mode.** Out of scope. The token system supports it but no
  dark tokens land here.