//! Transcript model: the row list the pane renders, and the coalescer that
//! feeds it. Port of the archived Rust `transcript/model.rs` (branch
//! `archive/gpui-rust`); the parity test replays the recorded capture through
//! this and asserts identity with the Rust golden.
//!
//! Two things happen here, and both come from `docs/rpc-events.md` §2:
//!
//! 1. `message_update` carries a **snapshot**, not a delta. Every
//!    `AssistantMessageEvent` variant ships `partial: AssistantMessage`
//!    holding the full accumulated message. So applying an update is a
//!    replace, never an append.
//!
//! 2. Updates arrive far above display rate, so they are coalesced to the
//!    redraw clock. ompweb's four ordering rules are reproduced exactly in
//!    `Coalescer` — getting rule 3 wrong renders a tool call before the
//!    text that preceded it.

export type Role = 'user' | 'assistant' | 'custom';

function parseRole(s: string): Role {
  return s === 'user' || s === 'assistant' ? s : 'custom';
}

/**
 * One rendered row. Tool calls are their own rows rather than nested inside
 * the assistant message, because they collapse independently
 * (`docs/transcript-rendering.md` §3) and the virtual list needs one height
 * per row.
 *
 * `rev` counts in-place mutations of the row. The model mutates rows rather
 * than replacing them (hot-path requirement), so React rows memo on
 * `(message, rev)` — the spec's "(message.id, message.revision)" key — to
 * see changes reference equality cannot.
 */
export type ChatMessage =
  | {
      row: 'text';
      id: string;
      role: Role;
      /** Markdown source; rendering is the pane's business. */
      text: string;
      /** True between `message_start` and `message_end`. */
      streaming: boolean;
      rev: number;
    }
  | {
      row: 'tool';
      id: string;
      /** Correlation key for `tool_execution_*` (`docs/rpc-events.md` §1.3). */
      toolCallId: string;
      name: string;
      /** One-line collapsed summary. See spec §2.5 for the per-tool rule. */
      summary: string;
      /** Populated by `tool_execution_end`; `null` while in flight. */
      result: string | null;
      expanded: boolean;
      rev: number;
    }
  | {
      /** Inline process/protocol notice (`docs/rpc-events.md` §1.4). */
      row: 'notice';
      id: string;
      level: 'info' | 'warning' | 'error';
      text: string;
      rev: number;
    }
  | {
      /**
       * Ephemeral turn summary lifted from the trailing assistant message's
       * prefix, e.g. `Ran 4 agents ›`. Not a tool row, not collapsible.
       */
      row: 'run_summary';
      id: string;
      text: string;
      rev: number;
    };

/** The subset of the RPC event stream the transcript reacts to. */
export type TranscriptEvent =
  | { event: 'agent_start' }
  | { event: 'agent_end'; isTerminal: boolean }
  | { event: 'message_start'; id: string; role: Role }
  | { event: 'message_update'; id: string; text: string }
  | { event: 'message_end'; id: string; role: Role; text: string }
  | { event: 'tool_start'; toolCallId: string; name: string; summary: string }
  | { event: 'tool_end'; toolCallId: string; result: string }
  | { event: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { event: 'other' };

/** The transcript's source of truth. The pane renders this and nothing else. */
export class TranscriptModel {
  messages: ChatMessage[] = [];
  /** Mirrors `agent_start` / `agent_end`-with-`isTerminal`. */
  streaming = false;
  /** Bumped on every mutation, so an event that changes nothing is free. */
  revision = 0;
  /**
   * Cached index of the streaming row. Scanning the vector is O(rows) per
   * flush — the streaming-cost benchmark caught it — so the cache keeps the
   * streaming loop O(1).
   */
  private streamingIdx: number | null = null;

  streamingIndex(): number | null {
    return this.streamingIdx;
  }

  /**
   * Replace-or-push by id. Snapshot semantics from `docs/rpc-events.md` §2 —
   * a `message_update` for an id we already hold overwrites its text
   * wholesale rather than appending a delta.
   */
  private upsertText(id: string, role: Role, text: string, streaming: boolean): void {
    // Hot path: the streaming row is the only one touched per flush.
    const ix = this.streamingIdx;
    if (ix !== null && streaming) {
      const row = this.messages[ix];
      if (row !== undefined && row.row === 'text' && row.id === id) {
        row.text = text;
        row.streaming = streaming;
        row.rev += 1;
        this.revision += 1;
        return;
      }
    }
    const existing = this.messages.findIndex((m) => m.id === id && m.row === 'text');
    if (existing >= 0) {
      const row = this.messages[existing] as Extract<ChatMessage, { row: 'text' }>;
      const wasStreaming = row.streaming;
      row.text = text;
      row.streaming = streaming;
      row.rev += 1;
      if (!wasStreaming && streaming) this.streamingIdx = existing;
      else if (wasStreaming && !streaming && this.streamingIdx === existing) this.streamingIdx = null;
    } else {
      this.messages.push({ row: 'text', id, role, text, streaming, rev: 0 });
      if (streaming) this.streamingIdx = this.messages.length - 1;
    }
    this.revision += 1;
  }

  /**
   * Lift an ephemeral summary prefix out of the trailing assistant message
   * into its own row (spec §2.6). Only the two prefixes observed in omp
   * output (`Ran N …` / `Read N …`) are accepted — false positives are
   * costlier than false negatives.
   */
  private promoteRunSummary(): void {
    let ix = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.row === 'text' && m.role === 'assistant') {
        ix = i;
        break;
      }
    }
    if (ix < 0) return;
    const row = this.messages[ix] as Extract<ChatMessage, { row: 'text' }>;
    const nl = row.text.indexOf('\n');
    if (nl < 0) return;
    const firstLine = row.text.slice(0, nl);
    const rest = row.text.slice(nl + 1);

    const words = firstLine.replace(/›+$/, '').split(/\s+/).filter((w) => w.length > 0);
    const verb = words[0];
    if (verb !== 'Ran' && verb !== 'Read') return;
    const count = Number.parseInt(words[1] ?? '', 10);
    if (!Number.isInteger(count) || String(count) !== words[1]) return;
    const noun = words.slice(2).join(' ');
    if (noun.length === 0 || rest.trim().length === 0) return;

    row.text = rest.replace(/^\s+/, '');
    row.rev += 1;
    this.messages.splice(ix, 0, {
      row: 'run_summary',
      id: `summary:${row.id}`,
      text: `${verb} ${count} ${noun} ›`,
      rev: 0,
    });
  }

  /** Toggle one tool row. Per-call, never global (spec §3). */
  toggleTool(toolCallId: string): void {
    for (const m of this.messages) {
      if (m.row === 'tool' && m.toolCallId === toolCallId) {
        m.expanded = !m.expanded;
        m.rev += 1;
        this.revision += 1;
        return;
      }
    }
  }

  /**
   * Merge one history page into the row list (spec §7). Both the page and
   * the loaded rows are ordered subsequences of the same authoritative
   * transcript, so a two-pointer merge suffices: a page row we already hold
   * (overlap with live-streamed rows or a stale_cursor re-fetch) syncs the
   * existing pointer past it; an unseen row is emitted in page order. For a
   * normal all-older page this degenerates to a prepend. Cold path (once
   * per page, never per token).
   */
  mergeHistory(rows: readonly ChatMessage[]): number {
    const indexById = new Map(this.messages.map((m, i) => [m.id, i]));
    const merged: ChatMessage[] = [];
    let existingPos = 0;
    let added = 0;
    for (const row of rows) {
      const known = indexById.get(row.id);
      if (known !== undefined) {
        // Copy existing rows up to and including the overlap. `known` is
        // always in range — we built indexById from this.messages — and the
        // while guard keeps existingPos ≤ known, so the access is safe.
        while (existingPos <= known) {
          const existing = this.messages[existingPos];
          if (existing === undefined) break;
          merged.push(existing);
          existingPos += 1;
        }
      } else {
        merged.push(row);
        added += 1;
      }
    }
    if (added === 0) return 0;
    while (existingPos < this.messages.length) {
      const tail = this.messages[existingPos];
      if (tail === undefined) break;
      merged.push(tail);
      existingPos += 1;
    }
    this.messages = merged;
    // Re-locate the cached streaming index — inserts above it shifted it.
    if (this.streamingIdx !== null) {
      const ix = this.messages.findIndex((m) => m.row === 'text' && m.streaming);
      this.streamingIdx = ix >= 0 ? ix : null;
    }
    this.revision += 1;
    return added;
  }

  /** Plain text of one row, for the per-message copy button (spec §6.2). */
  copyText(id: string): string | null {
    const m = this.messages.find((row) => row.id === id);
    if (m === undefined || m.row !== 'text') return null;
    return m.text;
  }

  /** Apply one decoded event. Returns whether anything changed. */
  apply(event: TranscriptEvent): boolean {
    const before = this.revision;
    switch (event.event) {
      case 'agent_start':
        this.streaming = true;
        this.revision += 1;
        break;
      // `isTerminal: false` means maintenance scheduled more work and the
      // session will resume — the spinner must NOT clear
      // (`docs/rpc-events.md` §1.1). Settling every row at once is the cold
      // path (once per turn, not once per token), so it scans.
      case 'agent_end':
        if (event.isTerminal) {
          this.streaming = false;
          for (const m of this.messages) {
            if (m.row === 'text' && m.streaming) {
              m.streaming = false;
              m.rev += 1;
            }
          }
          this.streamingIdx = null;
          this.promoteRunSummary();
        }
        this.revision += 1;
        break;
      case 'message_start':
        this.upsertText(event.id, event.role, '', event.role === 'assistant');
        break;
      case 'message_update':
        this.upsertText(event.id, 'assistant', event.text, true);
        break;
      case 'message_end':
        this.upsertText(event.id, event.role, event.text, false);
        break;
      case 'tool_start':
        this.messages.push({
          row: 'tool',
          id: `tool:${event.toolCallId}`,
          toolCallId: event.toolCallId,
          name: event.name,
          summary: event.summary,
          result: null,
          expanded: false,
          rev: 0,
        });
        this.revision += 1;
        break;
      case 'tool_end':
        for (const m of this.messages) {
          if (m.row === 'tool' && m.toolCallId === event.toolCallId) {
            m.result = event.result;
            m.rev += 1;
            this.revision += 1;
            break;
          }
        }
        break;
      case 'notice':
        this.messages.push({
          row: 'notice',
          id: `notice:${this.revision}`,
          level: event.level,
          text: event.message,
          rev: 0,
        });
        this.revision += 1;
        break;
      case 'other':
        break;
    }
    return this.revision !== before;
  }
}

/**
 * Reproduces ompweb's `message-update-coalescer.ts` ordering contract
 * (`docs/rpc-events.md` §2). The rules are load-bearing, not stylistic:
 *
 * 1. `message_update` → store as pending, schedule a flush.
 * 2. `message_end` → **drop** pending (the end frame carries the complete
 *    message and supersedes it), cancel the flush, dispatch the end.
 * 3. Any other event → flush pending **synchronously first**, then dispatch.
 * 4. Stream replaced / view unmounted → `reset()` drops pending.
 *
 * The flush *timing* is the caller's business; this type only enforces the
 * ordering.
 */
export class Coalescer {
  private pending: TranscriptEvent | null = null;
  /** Counts flushes actually applied — the headless test asserts this stays
   * far below the delta count, which is the whole point of coalescing. */
  flushes = 0;

  /** Feed one event. Returns the events to apply, in order. */
  feed(event: TranscriptEvent): TranscriptEvent[] {
    const out: TranscriptEvent[] = [];
    if (event.event === 'message_update') {
      // Rule 1: replace pending. The dropped one was a strict prefix
      // snapshot of this one, so nothing is lost.
      this.pending = event;
    } else if (event.event === 'message_end') {
      // Rule 2: the end frame supersedes any pending update.
      this.pending = null;
      out.push(event);
    } else {
      // Rule 3: flush first, then dispatch.
      if (this.pending !== null) {
        out.push(this.pending);
        this.pending = null;
        this.flushes += 1;
      }
      out.push(event);
    }
    return out;
  }

  /** Flush on the frame clock. */
  flush(): TranscriptEvent | null {
    const p = this.pending;
    this.pending = null;
    if (p !== null) this.flushes += 1;
    return p;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Rule 4: stream replaced or view unmounted. */
  reset(): void {
    this.pending = null;
  }
}

// ---------------------------------------------------------------------------
// Decoding: raw RPC JSON -> TranscriptEvent
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/**
 * Pull the concatenated text out of an `AgentMessage`'s content blocks.
 * Only `text` blocks contribute to the rendered prose; tool-call blocks
 * become their own rows via `tool_execution_*`.
 */
function contentText(v: unknown): string {
  const content = (v as Json | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Json => typeof b === 'object' && b !== null)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/**
 * Message id, falling back to the role when omp omits one. A missing id on a
 * streaming message would otherwise push a new row per frame.
 */
function messageId(v: unknown): string {
  const m = v as Json | null;
  if (typeof m?.id === 'string') return m.id;
  const role = typeof m?.role === 'string' ? m.role : '?';
  return `anon:${role}`;
}

function messageRole(v: unknown): Role {
  const role = (v as Json | null)?.role;
  return parseRole(typeof role === 'string' ? role : '');
}

/** One-line collapsed summary for a tool row (spec §2.5). */
export function toolSummary(name: string, args: unknown): string {
  const obj = typeof args === 'object' && args !== null ? (args as Json) : {};
  const field = (k: string): string | undefined =>
    typeof obj[k] === 'string' ? (obj[k] as string) : undefined;

  let summary: string | undefined;
  switch (name.toLowerCase()) {
    case 'bash':
    case 'shell': {
      // Spec §2.5: first non-whitespace token of the command — the verb.
      // Matches `light-view.png`'s `Bash   git status ›` shape, not the full
      // command (which is shown only in the expanded body).
      const cmd = field('command') ?? '';
      summary = cmd.trim().split(/\s+/, 1)[0] ?? '';
      break;
    }
    case 'read':
    case 'write':
    case 'edit':
      summary = field('path') ?? field('file_path');
      break;
    case 'grep':
    case 'search':
      summary = field('pattern') ?? field('query');
      break;
    case 'glob':
      summary = field('pattern');
      break;
    case 'task':
    case 'agent':
      summary = field('description') ?? field('task');
      break;
  }
  // Fall back to the first string-valued argument so an unknown tool still
  // shows something more useful than its bare name.
  summary ??= Object.values(obj).find((v): v is string => typeof v === 'string');

  const firstLine = (summary ?? '').split('\n')[0]?.trim() ?? '';
  const chars = Array.from(firstLine);
  return chars.length > 72 ? `${chars.slice(0, 71).join('')}…` : firstLine;
}

/**
 * Decode one page of `get_messages_page` history into settled rows
 * (spec §7). Only user/assistant text survives: toolResult and custom
 * entries have no `tool_execution_*` correlation in history, so rendering
 * them as pills would need a second decode path the live stream never
 * exercises.
 * ponytail: history tool calls render as nothing; add a history→tool-row
 * mapping if reading old tool output in scroll-back becomes a real ask.
 *
 * `pageKey` namespaces fallback ids so id-less messages from different
 * pages never collide (the live decoder's `anon:<role>` fallback would).
 */
export function historyRows(messages: unknown, pageKey: string): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ChatMessage[] = [];
  messages.forEach((m, i) => {
    const role = messageRole(m);
    if (role === 'custom') return;
    const text = contentText(m);
    if (text.trim().length === 0) return;
    const id = typeof (m as Json | null)?.id === 'string'
      ? ((m as Json).id as string)
      : `hist:${pageKey}:${i}`;
    out.push({ row: 'text', id, role, text, streaming: false, rev: 0 });
  });
  return out;
}

/**
 * Decode one NDJSON line into a `TranscriptEvent`.
 *
 * Unknown and unparseable lines yield `{event: 'other'}` rather than an
 * error: `docs/rpc-events.md` §5.3 requires that a malformed frame never
 * kills the stream, and extensions emit frame types beyond the documented set.
 */
export function decodeEvent(line: string): TranscriptEvent {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { event: 'other' };
  }
  return decodeEventValue(v);
}

/** Same as `decodeEvent`, for an already-parsed frame value (the renderer
 * receives structured-cloned frames, never raw NDJSON lines). */
export function decodeEventValue(v: unknown): TranscriptEvent {
  if (typeof v !== 'object' || v === null) return { event: 'other' };
  const frame = v as Json;
  const kind = typeof frame.type === 'string' ? frame.type : '';

  switch (kind) {
    case 'agent_start':
      return { event: 'agent_start' };
    case 'agent_end':
      // Optional field; absent means terminal (older runtimes).
      return { event: 'agent_end', isTerminal: frame.isTerminal !== false };
    case 'message_start': {
      const m = frame.message ?? null;
      return { event: 'message_start', id: messageId(m), role: messageRole(m) };
    }
    // Prefer `assistantMessageEvent.partial` over the outer `.message`: both
    // are full snapshots, but the inner one is the exact accumulated
    // assistant message the stream is building.
    case 'message_update': {
      const ame = frame.assistantMessageEvent as Json | undefined;
      const partial = ame?.partial ?? frame.message;
      if (partial === undefined || partial === null) return { event: 'other' };
      return {
        event: 'message_update',
        id: messageId(frame.message ?? partial),
        text: contentText(partial),
      };
    }
    case 'message_end': {
      const m = frame.message ?? null;
      return {
        event: 'message_end',
        id: messageId(m),
        role: messageRole(m),
        text: contentText(m),
      };
    }
    case 'tool_execution_start': {
      const name = typeof frame.toolName === 'string' ? frame.toolName : '';
      return {
        event: 'tool_start',
        toolCallId: typeof frame.toolCallId === 'string' ? frame.toolCallId : '',
        name: name === '' ? 'tool' : name,
        summary: toolSummary(name, frame.args),
      };
    }
    case 'tool_execution_end': {
      const result = frame.result;
      return {
        event: 'tool_end',
        toolCallId: typeof frame.toolCallId === 'string' ? frame.toolCallId : '',
        result:
          result === undefined
            ? ''
            : typeof result === 'string'
              ? result
              : JSON.stringify(result),
      };
    }
    default: {
      // Synthesized notice payload from `OmpPump` (frame-decode failure,
      // unexpected child exit): carries `level` + `message` but no `type`
      // field — the wire-shape `{"type":"notice",...}` from omp itself
      // stays `other` so the Rust-decoder parity golden stays valid.
      if (
        kind === '' &&
        (frame.level === 'info' || frame.level === 'warning' || frame.level === 'error') &&
        typeof frame.message === 'string'
      ) {
        return { event: 'notice', level: frame.level, message: frame.message };
      }
      return { event: 'other' };
    }
  }
}
