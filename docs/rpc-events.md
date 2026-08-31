# omp RPC event & command reference

Reference for the GPUI desktop client. Cite this instead of re-reading the 29 KB spec.

**Transport:** one `omp --mode rpc-ui --cwd <cwd>` child per session, NDJSON over stdio.
One JSON object per line, stdin = commands, stdout = ready frame + responses + events.

**Legend:** `[V]` verified in source (file:line). `[I]` inferred — reasoning given.
Sources are rooted at `T:\Code\OMP\omp\oh-my-pi\` (spec/impl) and `T:\Code\OMP\ompweb\`
(working reference client) unless absolute.

---

## 0. Framing and startup

| Fact | Value | Source |
|---|---|---|
| Ready frame | `{type:"ready", protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes, maxReassembledFrameBytes}` | `packages/coding-agent/src/modes/rpc/rpc-types.ts:144-150` [V] |
| Physical frame cap | 1 MiB (`1048576`) | `docs/rpc.md:43`; ompweb `lib/omp/rpc-frame.ts` `MAX_RPC_FRAME_BYTES` [V] |
| Reassembled cap | 64 MiB (`67108864`) | `docs/rpc.md:44`; ompweb `MAX_RPC_REASSEMBLED_BYTES` [V] |
| Negotiate v2 | `{id, type:"negotiate_protocol", protocolVersion:2}` → `data:{protocolVersion:2}` | `rpc-types.ts:30,198-204`; `rpc-mode.ts:1010-1013` [V] |
| Chunk frame | `{type:"rpc_chunk", chunkId, index, count, byteLength, data}` (`data` = base64 of a UTF-8 JSON slice) | `rpc-types.ts:152-159` [V] |

Client MUST: validate `chunkId`/`index`/`count`/`byteLength`, reject interleaved or
interrupted sequences, enforce the reassembly ceiling, concatenate in index order,
decode as strict UTF-8, parse as one JSON object (`docs/rpc.md:67`). Only v2 emits
chunks; a `rpc_chunk` arriving before negotiation is a protocol error — ompweb throws
`"RPC chunk received before protocol negotiation"` (`lib/omp/rpc-process.ts:150-151`) [V].

**Order of operations at spawn** (mirrors ompweb `lib/rpc-manager.ts:302-308`) [V]:
1. wait for `ready` (ompweb uses a timeout; a child that never readies is dead)
2. `negotiate_protocol` v2
3. `set_subagent_subscription` — **wrap in a catch**; older builds don't know the
   command and the UI must degrade to "no subagent info" rather than fail startup
4. `get_state` to learn `sessionId` / `sessionFile` / `isStreaming`

### Correlation

All commands take optional `id`. Responses echo it. **Match on `id`, never on emission
order** — `bash` is dispatched concurrently (`rpc-mode.ts:328-338`), so the RPC loop keeps
reading and answering other commands while a shell command runs [V].

Edge cases (`docs/rpc.md:101-105`) [V]:
- Unknown command → response with `id: undefined` even if the request had one.
- Malformed JSON / sync dispatch failure → `command:"parse"`, `id: undefined`, loop continues.
- `prompt` / `abort_and_prompt` return immediate success, then may emit a **later error
  response with the same `id`** if async scheduling fails. Do not free the pending-request
  slot on the success ack alone.

---

## 1. Outbound event catalogue

### 1.1 Agent lifecycle

| Event | Payload | UI state it mutates |
|---|---|---|
| `agent_start` | `{}` | `streaming = true`, `promptRunning = true`; show spinner; invalidate session list |
| `agent_end` | `{messages: AgentMessage[], isTerminal?: boolean, telemetry?, coverage?}` | Only clears streaming when `isTerminal !== false` |
| `turn_start` | `{}` | Turn boundary marker |
| `turn_end` | `{message: AgentMessage, toolResults: ToolResultMessage[]}` | Finalized turn |

`agent_end` shape: `packages/agent/src/types.ts:865-873` + `isTerminal` added in
`packages/coding-agent/src/session/agent-session-events.ts:14-17` [V].

**`isTerminal` is the single most important flag for the spinner.** `isTerminal: false`
means maintenance or async delivery has scheduled more work and the session will resume.
The field is *optional*: absent ⇒ treat as terminal (older runtimes). ompweb's guard is
literally `if (event.isTerminal !== false)` (`lib/rpc-manager.ts:390-391`) [V]. It also
holds a `continuationGraceUntil` window on non-terminal ends so the UI doesn't flicker
between segments (`lib/rpc-manager.ts:399-400`) [V].

### 1.2 Message lifecycle — see §2 for streaming semantics

| Event | Payload | Notes |
|---|---|---|
| `message_start` | `{message: AgentMessage}` | Emitted for user, assistant AND toolResult messages |
| `message_update` | `{message: AgentMessage, assistantMessageEvent: AssistantMessageEvent}` | **Assistant messages only, during streaming** |
| `message_end` | `{message: AgentMessage}` | Complete, final message |

`packages/agent/src/types.ts:877-881` [V].

### 1.3 Tool execution

| Event | Payload |
|---|---|
| `tool_execution_start` | `{toolCallId, toolName, args, intent?}` |
| `tool_execution_update` | `{toolCallId, toolName, args, partialResult}` |
| `tool_execution_end` | `{toolCallId, toolName, result, isError?}` |

`packages/agent/src/types.ts:883-886` [V]. Correlate by `toolCallId`. `partialResult` is
a snapshot of the tool's in-flight result, not a delta [I — mirrors the `partial` naming
and the `message_update` convention; no delta/offset field exists in the shape].

### 1.4 Session-level events (coding-agent additions)

All from `packages/coding-agent/src/session/agent-session-events.ts:18-66` [V]:

| Event | Payload | UI effect |
|---|---|---|
| `auto_compaction_start` | `{reason:"threshold"\|"overflow"\|"idle"\|"incomplete", action:"context-full"\|"remote"\|"handoff"\|"shake"\|"snapcompact"}` | `compacting = true`, banner |
| `auto_compaction_end` | `{action, result: CompactionResult\|undefined, aborted, willRetry, errorMessage?, skipped?}` | `compacting = false`; ompweb reads `result.estimatedTokensAfter` for the banner |
| `auto_retry_start` | `{attempt, maxAttempts, delayMs, errorMessage, errorId?}` | "Retrying (n/m)…" |
| `auto_retry_end` | `{success, attempt, finalError?, retryErrors?: RetryErrorUpdate[]}` | Clear retry banner |
| `retry_fallback_applied` | `{from, to, role}` | "Fell back to <to>" |
| `retry_fallback_succeeded` | `{model, role}` | Clear fallback warning |
| `model_changed` | `{}` — **no payload** | Signal only; must re-`get_state` to learn the new model |
| `thinking_level_changed` | `{thinkingLevel, configured?, resolved?}` | Thinking switcher label |
| `config_warnings_changed` | `{}` | Signal only |
| `advisor_cost_changed` | `{}` | Signal only |
| `ttsr_triggered` | `{rules: Rule[]}` | — |
| `todo_reminder` | `{todos: TodoItem[], attempt, maxAttempts}` | Todo panel |
| `todo_auto_clear` | `{}` | Clear todos |
| `irc_message` | `{message: CustomMessage}` | Custom message into transcript |
| `notice` | `{level:"info"\|"warning"\|"error", message, source?}` | Toast / inline notice |
| `goal_updated` | `{goal: Goal\|null, state?: GoalModeState}` | — |

Note the asymmetry: `model_changed` carries **nothing**, while `thinking_level_changed`
carries its new value. Model switcher must re-read state on that event [V].

### 1.5 Protocol-level frames (not `AgentSessionEvent`)

| Frame | Payload | Source |
|---|---|---|
| `available_commands_update` | `{commands: RpcAvailableSlashCommand[]}` | `rpc-types.ts:133-136` [V] |
| `prompt_result` | `{id?: string, agentInvoked: boolean}` | `rpc-types.ts:138-142` [V] |
| `extension_error` | `{extensionPath, event, error}` | `docs/rpc.md:492-498` [V] |
| `command_output` | `{text: string}` | `rpc-mode.ts:1030` [V] |
| `session_info_update` | `{title, sessionId}` | `rpc-mode.ts:1035` [V] |
| `config_update` | `{model, thinkingLevel}` | `rpc-mode.ts:1038` [V] |

`RpcAvailableSlashCommand` = `{name, source, aliases?, description?, input?:{hint?},
subcommands?: Array<{name, description?, usage?}>}` (`rpc-types.ts:124-131`) [V]. Pushed
at startup and whenever command metadata changes — the sidebar/command palette should
treat it as authoritative and replace wholesale, not merge.

**`command_output` / `session_info_update` / `config_update` are emitted only from the
builtin slash-command path** — they are `output(...)` callbacks passed into
`executeAcpBuiltinSlashCommand` (`rpc-mode.ts:1024-1039`) [V]. They are the side channel
for local-only commands like `/mcp list`. ompweb intercepts `command_output` when a
specific waiter is pending and otherwise ignores it rather than injecting it into the
chat stream (`lib/rpc-manager.ts:356-367`) [V]. `session_info_update` updates the cached
session name (`lib/rpc-manager.ts:418-420`) [V].

### 1.6 Extension UI, host tools, host URIs

Full request/response sub-protocols exist (`rpc-types.ts:376-440`, `446-540`) [V]:
- `extension_ui_request` methods: `select` (with optional positional `optionDetails`),
  `confirm`, `input`, `editor`, `cancel`, `notify`, `setStatus`, `setWidget`, `setTitle`,
  `set_editor_text`, `open_url` (carries `launchUrl?` + `instructions?` for OAuth).
- Reply with `extension_ui_response`: `{id, value}` | `{id, confirmed}` | `{id, cancelled:true, timedOut?}`.
- `host_tool_call` / `host_tool_cancel` out; `host_tool_update` / `host_tool_result` in.
- `host_uri_request` / `host_uri_cancel` out; `host_uri_result` in.

**MVP scope:** the desktop client registers no host tools and no URI schemes, so
`host_tool_*` and `host_uri_*` should never arrive. `extension_ui_request` **can** arrive
unsolicited from any installed extension. A client that ignores it will hang that
extension until its timeout. Minimum viable handling: reply
`{type:"extension_ui_response", id, cancelled:true}` to every request you don't render [I —
the cancel response shape is verified; treating it as the safe default is our decision].
`setTitle` is suppressed by default in RPC mode unless `PI_RPC_EMIT_TITLE=1`
(`docs/rpc.md:601-604`) [V].

---

## 2. Streaming semantics of `message_update` — SNAPSHOT, not delta

**This is the headline finding.**

```ts
{ type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
```

`AssistantMessageEvent` (`packages/ai/src/types.ts:1289-1310`) [V]:

```ts
| { type: "start";          contentIndex?: undefined; partial: AssistantMessage }
| { type: "text_start";     contentIndex: number; partial: AssistantMessage }
| { type: "text_delta";     contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "text_end";       contentIndex: number; content: string; partial: AssistantMessage }
| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "thinking_end";   contentIndex: number; content: string; partial: AssistantMessage }
| { type: "image_end";      contentIndex: number; content: ImageContent; partial: AssistantMessage }
| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
| { type: "toolcall_end";   contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
| { type: "done";  contentIndex?: undefined; reason: "stop"|"length"|"toolUse"; message: AssistantMessage }
| { type: "error"; contentIndex?: undefined; reason: "aborted"|"error";        error: AssistantMessage }
```

### The answer

**Every variant carries `partial: AssistantMessage` — the full accumulated message so
far.** The `delta` fields exist *alongside* the snapshot, not instead of it. The outer
`message_update.message` is likewise a whole `AgentMessage`, not a patch.

So a client has two valid strategies:
- **Snapshot replace (recommended):** on each `message_update`, replace the streaming
  message with `assistantMessageEvent.partial` (or the outer `.message`). Stateless,
  cannot drift, survives dropped/coalesced frames.
- **Delta append:** accumulate `delta` per `contentIndex`. Faster in principle, but any
  dropped or reordered frame silently corrupts the transcript, and you must handle
  `contentIndex` as a sparse block index across text/thinking/toolcall blocks.

Independent confirmation from the working client: ompweb's coalescer header states
*"every frame carries the FULL accumulated partial message, so dispatching each one
re-renders the whole streaming bubble"* and therefore drops all but the latest pending
update (`lib/message-update-coalescer.ts:1-12`) [V]. **Dropping intermediate
`message_update` frames is safe** — proof that they are snapshots.

> **Recommendation for GPUI:** snapshot replace, plus coalescing. omp emits
> `message_update` per token batch, far above display rate. Buffer the latest pending
> update and flush on the frame clock. ompweb uses `requestAnimationFrame` with a 50 ms
> trailing-timer fallback for hidden tabs (`lib/message-update-coalescer.ts:27-38`) [V];
> the GPUI analogue is flushing once per redraw.
>
> **Coalescer ordering contract** (`lib/message-update-coalescer.ts:8-12`, implemented at
> `:62-78`) [V] — reproduce this exactly:
> 1. `message_update` → store as pending, schedule a flush.
> 2. `message_end` → **drop** the pending update (it carries the complete message and
>    supersedes it), cancel the flush, dispatch `message_end`.
> 3. Any other event type → flush the pending update **synchronously first**, then
>    dispatch the event. Otherwise a `tool_execution_start` can be applied before the
>    text that preceded it.
> 4. Stream replaced / view unmounted → `reset()`: drop pending, cancel the flush.

### How do you know a message is complete?

Three independent completion signals, in increasing scope:

1. **Per-message:** `message_end` with the final `{message}`. This is the authoritative
   per-message completion. `docs/rpc.md:479` [V].
2. **Per-stream:** `assistantMessageEvent.type === "done"` (with `message`) or `"error"`
   (with `error` and `reason: "aborted"|"error"`) — carried *inside* a `message_update`,
   so it tells you the model stream ended and why. `packages/ai/src/types.ts:1301-1309` [V].
3. **Per-run:** `agent_end` with `isTerminal !== false`. This ends the whole turn,
   including any tool loop. `agent-session-events.ts:14-17` [V].

For "is the bubble still streaming?", use `message_end`. For "is the composer re-enabled?",
use `agent_end` with the `isTerminal` guard, **or** the local-only completion path in §4.

---

## 3. The subagent channel

### 3.1 Subscription levels

`set_subagent_subscription` with `level: "off" | "progress" | "events"`; **default is
`"off"`** (`rpc-types.ts:165`, `docs/rpc.md:526`) [V]. The gating is a plain level check
in `RpcSubagentRegistry`:

| Frame | Emitted when | Gate site |
|---|---|---|
| `subagent_lifecycle` | `level !== "off"` | `rpc-subagents.ts:210-212` [V] |
| `subagent_progress` | `level !== "off"` | `rpc-subagents.ts:237-239` [V] |
| `subagent_event` | `level === "events"` | `rpc-subagents.ts:244-245` [V] |

So `"progress"` = lifecycle + progress; `"events"` = those plus every raw
`AgentSessionEvent` from inside each child. **ompweb subscribes at `"events"`**
(`lib/rpc-manager.ts:307`) [V].

Important: the registry keeps its internal snapshot map up to date **regardless of
subscription level** — `handleLifecycle` / `handleProgress` mutate `#subagents` before
the level check. Only *forwarding* is gated. So `get_subagents` returns a correct roster
even at `"off"` (`rpc-subagents.ts:182-240`) [V].

### 3.2 Frame payloads

```ts
// rpc-types.ts:348-363
{ type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }
{ type: "subagent_progress";  payload: SubagentProgressPayload }
{ type: "subagent_event";     payload: SubagentEventPayload }
```

```ts
// packages/coding-agent/src/task/types.ts:88-101
interface SubagentLifecyclePayload {
  id: string; agent: string; agentSource: "bundled"|"user"|"project";
  description?: string;
  status: "started" | "completed" | "failed" | "aborted";
  sessionFile?: string; parentToolCallId?: string; index: number;
  detached?: boolean;   // only detached spawns belong in a background-tasks HUD
}

// task/types.ts:68-79
interface SubagentProgressPayload {
  index: number; agent: string; agentSource: AgentSource; task: string;
  parentToolCallId?: string; assignment?: string;
  progress: AgentProgress;          // <-- all the numbers live here
  sessionFile?: string; detached?: boolean;
}

// task/types.ts:82-85
interface SubagentEventPayload { id: string; event: AgentSessionEvent }
```

`AgentProgress` (`task/types.ts:398-468`) — the fields our panel needs [V]:

```ts
index, id, status: "pending"|"running"|"completed"|"failed"|"aborted",
task, assignment?, description?, lastIntent?,
currentTool?, currentToolArgs?, currentToolStartMs?,
recentTools: Array<{tool, args, endMs}>, recentOutput: string[],
toolCount: number,        // "8 tool uses"
requests: number,         // assistant message_end count
tokens: number,           // "67.1k tokens" — cumulative input+output+cacheWrite, EXCLUDES cacheRead
contextTokens?: number,   // current per-turn context size (compare to contextWindow)
contextWindow?: number,
cost: number,             // USD
durationMs: number,       // "55s"
modelOverride?, modelRole?, resolvedModel?, resolvedModelIsFallback?,
extractedToolData?, retryState?, retryFailure?, inflightTaskDetails?
```

### 3.3 Background-tasks panel — field mapping

Every numeric field the panel shows lives in `AgentProgress`, i.e. it arrives **only via
`subagent_progress` (or a `get_subagents` snapshot's `.progress`)**. `subagent_lifecycle`
carries the identity and terminal status but **no counters**.

| Panel field | Source field | Carried by | Min level |
|---|---|---|---|
| Agent name | `payload.agent` (+ `description`/`task` for the subtitle) | lifecycle, progress, `get_subagents` | `progress` |
| Status `Completed`/`Failed`/running | lifecycle `status` (`started`→running, else terminal) or `progress.status` | both | `progress` |
| Elapsed `55s` | `progress.durationMs` | **progress only** | `progress` |
| Tokens `67.1k tokens` | `progress.tokens` | **progress only** | `progress` |
| Tool uses `8 tool uses` | `progress.toolCount` | **progress only** | `progress` |
| "View transcript" link | `sessionFile` (lifecycle or progress) → feeds `get_subagent_messages` | both | `progress` |
| Live "running X" line | `progress.currentTool` / `currentToolArgs` / `lastIntent` | **progress only** | `progress` |
| Cost / model / context gauge | `progress.cost`, `resolvedModel`, `contextTokens`/`contextWindow` | **progress only** | `progress` |

**Conclusion: `"progress"` is sufficient for the entire Background-tasks panel.**
`"events"` is only needed to mirror a subagent's transcript *live*; the transcript dialog
can instead poll `get_subagent_messages`, which is cheaper. ompweb subscribes at
`"events"` — we do not have to. [I on the recommendation; [V] on the field-to-frame
mapping, which is what makes it safe.]

Status normalization gotcha: lifecycle `"started"` maps to progress status `"running"`
(`rpc-subagents.ts:37-39`) [V]. Terminal lifecycle statuses (`completed`/`failed`/
`aborted`) **delete the entry from the registry** (`rpc-subagents.ts:205-209`) [V] — so a
finished agent disappears from `get_subagents` but its final `subagent_lifecycle` frame
still arrives. **The UI must retain finished rows itself**; do not treat `get_subagents`
as the whole panel model. Its `sessionFile` is retained separately for transcript reads
(`#transcriptSessionFilesBySubagentId`, capped at 256 entries, `rpc-subagents.ts:31,161-170`) [V].

Formatting reference (ompweb `lib/subagent-format.ts`) [V]: tokens → `k` suffix, 1 dp
below 10 000 and 0 dp above; duration → `null` under 1 s, `Ns` under a minute, `Nm` above;
cost → 4 dp below `$0.01`. These match the `67.1k tokens` / `55s` strings in the
screenshots.

### 3.4 `get_subagents` and `get_subagent_messages`

`get_subagents` → `{subagents: RpcSubagentSnapshot[]}`, sorted by `index` then `id`
(`rpc-subagents.ts:157-159`) [V]:

```ts
// rpc-types.ts:167-180
interface RpcSubagentSnapshot {
  id; index; agent; agentSource; description?; status;
  task?; assignment?; sessionFile?; lastUpdate: number;
  progress?: AgentProgress;   // optional! absent until the first progress frame
  parentToolCallId?;
}
```

`get_subagent_messages` — `{subagentId?, sessionFile?, fromByte?}` → `RpcSubagentMessagesResult`:

```ts
// rpc-types.ts:182-189
{ sessionFile: string; fromByte: number; nextByte: number; reset: boolean;
  entries: FileEntry[]; messages: AgentMessage[] }
```

Transcript-dialog loop, from `readRpcSubagentTranscript` (`rpc-subagents.ts:68-105`) [V]:

1. Open with `{subagentId}` (or `{sessionFile}`) and no `fromByte` → full transcript.
2. Render `messages` (already converted); `entries` is the raw session-file record stream
   if you need non-message entries.
3. Store `nextByte`. Poll with `fromByte: nextByte` for incremental tail reads.
4. **`reset: true`** means `fromByte` exceeded the current file size, so the server
   restarted at byte 0 — **discard your accumulated transcript and re-render from this
   response** (`rpc-subagents.ts:86-89`) [V].
5. Reads are newline-aligned: the server truncates at the last `\n` and reports `nextByte`
   accordingly, so a partially-written line is never parsed (`rpc-subagents.ts:92-95`) [V].
   A poll that returns `nextByte === fromByte` with empty `messages` is normal.
6. A missing file returns an empty result rather than an error (`rpc-subagents.ts:74-84`) [V].

Selector resolution can throw: `"Unknown subagent or session file unavailable: <id>"`,
`"Unknown subagent session file"`, or `"get_subagent_messages requires subagentId or
sessionFile"` (`rpc-subagents.ts:248-264`) [V]. Note `sessionFile` is only accepted if the
registry has seen it — you cannot read an arbitrary path. Prefer `subagentId`, which also
resolves through the retained-transcript map after the agent finished.

Both commands fail with `"Subagent event bus unavailable"` when the bus is absent
(`rpc-mode.ts:1180,1195`) [V] — another reason to treat subagent support as optional.

---

## 4. MVP command surface

All confirmed present in `RpcCommand` (`rpc-types.ts:28-93`) and handled in `rpc-mode.ts` [V].

| Command | Request | Success `data` | Notes |
|---|---|---|---|
| `prompt` | `{message, images?, streamingBehavior?:"steer"\|"followUp"}` | `{agentInvoked: boolean}` **optional** | Immediate ack ≠ completion. See below. |
| `steer` | `{message, images?}` | — | Interrupt path |
| `follow_up` | `{message, images?}` | — | Post-turn path |
| `abort` | `{}` | — | |
| `abort_and_prompt` | `{message, images?}` | — | Never emits `agentInvoked` or `prompt_result` (`docs/rpc.md:105`) |
| `set_model` | `{provider, modelId}` | `Model` | Failure: `"Model not found: provider/model"` |
| `get_available_models` | `{}` | `{models: Model[]}` | |
| `cycle_model` | `{}` | `{model, thinkingLevel, isScoped} \| null` | |
| `set_thinking_level` | `{level: ThinkingLevel}` | — (no data) | Levels: `off\|minimal\|low\|medium\|high\|xhigh\|max` |
| `cycle_thinking_level` | `{}` | `{level: Effort} \| null` | |
| `get_state` | `{}` | `RpcSessionState` | See §4.2 |
| `get_messages_page` | `{cursor?, limit?}` | `{messages, nextCursor?, totalMessages}` | See §5 |
| `get_messages` | `{}` | `{messages}` | Legacy monolith; can overflow the frame cap |
| `switch_session` | `{sessionPath}` | `{cancelled: boolean}` | **Can be cancelled — check the flag** |
| `new_session` | `{parentSession?}` | `{cancelled: boolean}` | Same |

Also available and likely wanted: `get_available_commands` → `{commands}`,
`set_session_name` (rejects empty), `get_session_stats` → `SessionStats`, `compact`,
`set_auto_compaction`, `set_fast_mode` → `{enabled, active}`, `set_todos`, `branch`,
`get_branch_messages`, `get_last_assistant_text`, `handoff`, `export_html`, `bash`,
`abort_bash`, `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`,
`set_auto_retry`, `abort_retry`, `get_login_providers`, `login` (`rpc-types.ts:28-93`) [V].

### 4.1 Prompt completion — the three-way branch

`prompt` acks on **acceptance**, not completion (`docs/rpc.md:211,545-556`) [V]. Three paths:

- `data.agentInvoked === true` → an agent turn is running. Wait for `agent_end` with
  `isTerminal !== false`. Events may arrive **before or after** the prompt response.
- `data.agentInvoked === false` → local-only (e.g. a slash command producing
  `command_output`). **Complete now.** No `agent_end` will ever arrive.
- `data` **omitted** (older runtime) → you cannot tell from the ack. Wait for `agent_end`,
  or a later `prompt_result` frame `{id?, agentInvoked}` which resolves it.

ompweb synthesizes a local `prompt_result` when the ack already says
`agentInvoked: false`, so one code path handles all three (`lib/rpc-manager.ts:962-967`) [V].
It also runs an `awaitingAgentStart` deadline, because a promised `agent_start` that never
arrives would otherwise spin forever (`lib/rpc-manager.ts:44`, `:1011-1012`) [V] — worth
copying.

### 4.2 `get_state` → `RpcSessionState`

`rpc-types.ts:99-122` [V]:

```ts
model?: Model; thinkingLevel: ThinkingLevel|undefined;
isStreaming: boolean; isCompacting: boolean;
steeringMode: "all"|"one-at-a-time"; followUpMode: "all"|"one-at-a-time";
interruptMode: "immediate"|"wait";
sessionFile?: string; sessionId: string; sessionName?: string;
autoCompactionEnabled: boolean; fastModeEnabled: boolean; fastModeActive: boolean;
tokensPerSecond: number|null; messageCount: number; queuedMessageCount: number;
todoPhases: TodoPhase[];
systemPrompt?: string[]; dumpTools?: [...]; contextUsage?: {tokens, contextWindow, percent}
```

This is the reconciliation anchor: after any dropped-frame suspicion, after `model_changed`
(which carries no payload), and at spawn.

### 4.3 Streaming-time prompt rules

`AgentSession.prompt()` **requires** `streamingBehavior` while streaming; omitting it
during an active stream **fails** (`docs/rpc.md:559-565`) [V]. Either always send
`streamingBehavior` derived from a live `isStreaming` flag, or use the dedicated `steer` /
`follow_up` commands, which need no such flag. **`steer`/`follow_up` is the simpler
design** — no local streaming-state race to lose [I].

Queue defaults: `steeringMode:"one-at-a-time"`, `followUpMode:"one-at-a-time"`,
`interruptMode:"immediate"` (`docs/rpc.md:568-573`) [V]. `"immediate"` lets pending steering
abort remaining tool calls mid-turn; `"wait"` defers to turn end.

### 4.4 MVP gaps — things RPC does NOT offer

Flagged explicitly, as requested.

1. **No session list / enumeration command.** `RpcCommand` has `switch_session
   {sessionPath}` but nothing that *lists* sessions or resolves a path. The sidebar cannot
   be built from RPC. ompweb builds it out-of-band by walking the sessions directory
   (`lib/session-files.ts`, ~46 KB; plus `session-reader.ts`, `session-watcher.ts`) and
   caches it (`invalidateSessionListCache()` called on `agent_start` / `agent_end` /
   `session_info_update` in `lib/rpc-manager.ts:373,398,420`) [V]. **The desktop client
   needs its own session-file discovery layer.** This is the largest gap.
2. **No per-session cwd query beyond `get_state`.** `sessionFile` is returned, but a
   session whose recorded cwd was deleted spawns in a substituted directory *silently*.
   ompweb compares its own `recordedCwd` against the spawn cwd and emits a synthetic
   warning `notice` (`lib/rpc-manager.ts:314-322`) [V]. RPC will not tell you.
3. **No process-exit event.** Child death is only observable via the OS (exit code /
   stderr). ompweb tails stderr, emits a synthetic `notice` and a synthetic terminal
   `agent_end` so a mid-stream UI stops spinning (`lib/rpc-manager.ts:335-347`) [V]. **We
   must synthesize the same two frames** or the transcript spins forever on a crash.
4. **`model_changed` carries no payload** — a `get_state` round-trip is mandatory to
   update the model switcher (`agent-session-events.ts:50`) [V].
5. **No cancellation for in-flight non-`bash` commands.** Only `abort` (agent) and
   `abort_bash` exist. A slow `get_messages_page` cannot be cancelled; the client needs its
   own timeout + discard-by-`id` [I].
6. **No resumable event stream / sequence numbers.** Events are fire-and-forget with no
   cursor. If the client misses frames it must re-`get_state` + re-page messages. There is
   no "replay since N" (absence verified across `rpc-types.ts` and `docs/rpc.md`) [V-absence].
7. **`get_subagents` drops finished agents** (§3.3). The Background-tasks panel's
   "Completed"/"Failed" rows must be retained client-side from `subagent_lifecycle`.
8. **No structured markdown/diff rendering hints.** Tool results are raw; all rendering
   (syntax highlight, diff view, file links) is the client's problem — cf. ompweb's
   `markdown.ts`, `syntax-highlight.ts`, `patch.ts`, `file-links.ts` [V].

---

## 5. Failure modes

### 5.1 Response-level errors

`{id?, type:"response", command: string, success:false, error: string, code?: string}`
(`rpc-types.ts:342`) [V]. `code` is the machine-readable reason — **match on `code`, never
on `error` text**.

### 5.2 `get_messages_page` codes

Only two codes are defined protocol-wide (`rpc-messages.ts:13`) [V]:

| `code` | `error` text | Fires when | Client action |
|---|---|---|---|
| `session_busy` | `"Cannot page messages while the session is changing"` | Guard at request entry: `session.isStreaming \|\| session.isCompacting` (`rpc-mode.ts:1388-1390`) [V] | Discard partial pages; retry after `agent_end` / `auto_compaction_end`, or fall back to `get_messages` |
| `stale_cursor` | `"RPC message cursor is stale"` | Cursor's `{sessionId, leafId, messageCount}` no longer matches the live snapshot — e.g. a background `bash` appended a message between pages (`rpc-messages.ts:84-107`) [V] | Discard partial pages and **restart paging from no cursor** |

The bundled clients discard partial pages and fall back to the legacy monolithic
`get_messages` on either code (`docs/rpc.md:193`; `rpc-client.ts:261`) [V]. That fallback
can overflow the v1 frame cap on a large history — under negotiated v2 it is chunked and
safe.

Cursor mechanics (`rpc-messages.ts:48-90`) [V]: base64url of
`{version:1, sessionId, leafId, messageCount, offset}`, max 2048 chars, strictly validated
(round-trip re-encode check, safe-integer bounds, `offset <= messageCount`). Treat it as
fully opaque. An invalid/corrupt cursor throws `"Invalid RPC message cursor"` — note this
is a **plain `Error` with no `code`**, unlike the two above [V].

Paging bounds: default limit 100, max 256, plus a **768 KiB soft byte budget per page** —
a page may return fewer than `limit` messages when the byte budget is hit
(`rpc-messages.ts:4-6,113-119`) [V]. **Never infer "last page" from a short page; only the
absence of `nextCursor` means done** (`rpc-messages.ts:121-126`) [V]. A single message
larger than the frame cap still overflows on v1; v2 framing is required to retrieve it.

### 5.3 Other documented failures

- **Malformed JSONL** → `{command:"parse", id: undefined, success:false}`; the loop
  continues reading (`docs/rpc.md:27,785`) [V]. Never fatal.
- **Unknown command** → failure with `id: undefined` — it will not resolve your pending
  request. Time out by `id` (`docs/rpc.md:101`) [V].
- **`handoff` while streaming** → `"Cannot hand off while a response is in progress"`
  (`rpc-mode.ts:1373-1375`) [V].
- **Empty `set_session_name`** → `"Session name cannot be empty"` (`docs/rpc.md:786`) [V].
- **`set_fast_mode` on an unsupported model** → `"Fast mode is unavailable for the current
  model."` Disable is idempotent but does not guarantee `active:false`, since provider-level
  settings (Fireworks `priority`) can keep it active (`docs/rpc.md:322-360`) [V].
- **Unknown `extension_ui_response` id** → silently ignored (`docs/rpc.md:787`) [V].
- **Subagent commands without an event bus** → `"Subagent event bus unavailable"`
  (`rpc-mode.ts:1180,1195`) [V].
- **stdin close** → pending extension-UI / host-tool / host-URI requests are rejected,
  accepted commands drain, session disposes, **exit code 0** (`docs/rpc.md:29`) [V]. A
  clean exit is not an error.

---

## 6. Minimum viable client checklist

1. Spawn, read NDJSON lines, decode `ready`, negotiate v2, reassemble `rpc_chunk`.
2. Dispatch pending requests **by `id`**, with per-request timeouts; tolerate late
   same-`id` error responses for `prompt`.
3. Coalesce `message_update` to the redraw clock; apply `partial` as a snapshot; honour
   the four ordering rules in §2.
4. Gate the spinner on `agent_end && isTerminal !== false`, plus the local-only
   (`agentInvoked:false` / `prompt_result`) path.
5. `set_subagent_subscription: "progress"` (in a catch), and retain terminal rows locally.
6. Re-`get_state` after `model_changed` and after any suspected desync.
7. Answer or cancel every `extension_ui_request`.
8. Synthesize a `notice` + terminal `agent_end` on unexpected child exit.
9. Build session enumeration outside RPC (gap #1).
