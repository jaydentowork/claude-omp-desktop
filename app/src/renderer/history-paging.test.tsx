// History paging (issue #26, spec §7): the store issues `get_messages_page`
// by correlation id, prepends decoded pages without disturbing the streaming
// tail, retries `session_busy` on the next terminal agent_end, and restarts
// from no cursor on `stale_cursor`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptModel, historyRows } from '../main/omp-rpc';
import { TranscriptStore, type StreamBatch } from './omp-provider';

/** Wire-shape AgentMessage for page payloads. */
const wireMsg = (id: string, role: string, text: string) => ({
  id,
  role,
  content: [{ type: 'text', text }],
});

/** Batch carrying a single response frame, as the preload relay delivers. */
const responseBatch = (seq: number, payload: unknown): StreamBatch => ({
  seq,
  frames: [{ kind: 'response', payload }],
});

const eventBatch = (seq: number, kind: string, payload: unknown): StreamBatch => ({
  seq,
  frames: [{ kind, payload }],
});

function storeWithSentLog() {
  const store = new TranscriptStore();
  const sent: Array<Record<string, unknown>> = [];
  store.send = (c) => sent.push(c as Record<string, unknown>);
  return { store, sent };
}

describe('historyRows', () => {
  it('maps user/assistant text and skips custom/empty entries', () => {
    const rows = historyRows(
      [
        wireMsg('u1', 'user', 'hello'),
        wireMsg('c1', 'toolResult', 'ignored'),
        wireMsg('a1', 'assistant', 'world'),
        wireMsg('e1', 'user', '   '),
      ],
      'p1',
    );
    expect(rows.map((r) => r.id)).toEqual(['u1', 'a1']);
    expect(rows.every((r) => r.row === 'text' && !r.streaming)).toBe(true);
  });

  it('namespaces fallback ids per page so pages never collide', () => {
    const a = historyRows([{ role: 'user', content: [{ type: 'text', text: 'x' }] }], 'p1');
    const b = historyRows([{ role: 'user', content: [{ type: 'text', text: 'y' }] }], 'p2');
    expect(a[0]?.id).not.toBe(b[0]?.id);
  });
});

describe('TranscriptModel.mergeHistory', () => {
  it('prepends, dedupes by id, and keeps the streaming index valid', () => {
    const model = new TranscriptModel();
    model.apply({ event: 'message_start', id: 'live', role: 'assistant' });
    model.apply({ event: 'message_update', id: 'live', text: 'streaming…' });
    const before = model.streamingIndex();
    expect(before).toBe(0);

    const added = model.mergeHistory([
      { row: 'text', id: 'old1', role: 'user', text: 'old', streaming: false, rev: 0 },
      { row: 'text', id: 'live', role: 'assistant', text: 'dupe', streaming: false, rev: 0 },
    ]);
    expect(added).toBe(1);
    expect(model.messages.map((m) => m.id)).toEqual(['old1', 'live']);
    // The cached streaming index shifted with the prepend — the hot path
    // still lands on the tail row (spec §9 finding 3).
    expect(model.streamingIndex()).toBe(1);
    model.apply({ event: 'message_update', id: 'live', text: 'streaming more' });
    const tail = model.messages[1];
    expect(tail?.row === 'text' && tail.text).toBe('streaming more');
  });
});

describe('TranscriptStore history paging', () => {
  it('issues the no-cursor initial page and prepends the response', () => {
    const { store, sent } = storeWithSentLog();
    store.startHistory();
    expect(store.getState().history).toEqual({ phase: 'initial' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'get_messages_page', limit: 256 });
    expect(sent[0]?.cursor).toBeUndefined();

    store.apply(
      responseBatch(1, {
        id: sent[0]?.id,
        type: 'response',
        command: 'get_messages_page',
        success: true,
        data: {
          messages: [wireMsg('h1', 'user', 'earlier'), wireMsg('h2', 'assistant', 'reply')],
          nextCursor: 'CURSOR-1',
        },
      }),
    );
    expect(store.model.messages.map((m) => m.id)).toEqual(['h1', 'h2']);
    // nextCursor present → the pill shows (spec §7.2).
    expect(store.getState().history).toEqual({ phase: 'idle', hasMore: true });
  });

  it('pages older history with the cursor and stops when nextCursor is absent', () => {
    const { store, sent } = storeWithSentLog();
    store.startHistory();
    store.apply(
      responseBatch(1, {
        id: sent[0]?.id,
        type: 'response',
        success: true,
        data: { messages: [wireMsg('h9', 'user', 'newest old')], nextCursor: 'C1' },
      }),
    );

    store.loadEarlier();
    expect(store.getState().history).toEqual({ phase: 'loading', hasMore: true });
    expect(sent[1]).toMatchObject({ type: 'get_messages_page', cursor: 'C1', limit: 256 });

    store.apply(
      responseBatch(2, {
        id: sent[1]?.id,
        type: 'response',
        success: true,
        data: { messages: [wireMsg('h1', 'user', 'oldest')] }, // no nextCursor → done
      }),
    );
    expect(store.model.messages.map((m) => m.id)).toEqual(['h1', 'h9']);
    expect(store.getState().history).toEqual({ phase: 'idle', hasMore: false });
    // No cursor left — further loadEarlier calls send nothing.
    store.loadEarlier();
    expect(sent).toHaveLength(2);
  });

  it('retries a session_busy page on the next terminal agent_end', () => {
    const { store, sent } = storeWithSentLog();
    store.startHistory();
    store.apply(
      responseBatch(1, {
        id: sent[0]?.id,
        type: 'response',
        success: false,
        code: 'session_busy',
        error: 'Cannot page messages while the session is changing',
      }),
    );
    expect(store.getState().history).toEqual({ phase: 'busy', hasMore: true });

    // Non-terminal end must NOT retry (spec §7.1 step 5).
    store.apply(eventBatch(2, 'agent_end', { type: 'agent_end', isTerminal: false }));
    expect(sent).toHaveLength(1);

    store.apply(eventBatch(3, 'agent_end', { type: 'agent_end', isTerminal: true }));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: 'get_messages_page' });
  });

  it('restarts from no cursor on stale_cursor', () => {
    const { store, sent } = storeWithSentLog();
    store.startHistory();
    store.apply(
      responseBatch(1, {
        id: sent[0]?.id,
        type: 'response',
        success: true,
        data: { messages: [wireMsg('h5', 'user', 'page one')], nextCursor: 'C1' },
      }),
    );
    store.loadEarlier();
    store.apply(
      responseBatch(2, {
        id: sent[1]?.id,
        type: 'response',
        success: false,
        code: 'stale_cursor',
        error: 'RPC message cursor is stale',
      }),
    );
    // Restarted from scratch: a fresh no-cursor request went out.
    expect(sent[2]).toMatchObject({ type: 'get_messages_page', limit: 256 });
    expect(sent[2]?.cursor).toBeUndefined();

    // The overlap in the re-fetched page dedupes by id.
    store.apply(
      responseBatch(3, {
        id: sent[2]?.id,
        type: 'response',
        success: true,
        data: { messages: [wireMsg('h5', 'user', 'page one'), wireMsg('h6', 'assistant', 'new')] },
      }),
    );
    expect(store.model.messages.map((m) => m.id)).toEqual(['h5', 'h6']);
  });

  it('ignores responses whose id does not match the in-flight page', () => {
    const { store, sent } = storeWithSentLog();
    store.startHistory();
    store.apply(
      responseBatch(1, {
        id: 'somebody-else',
        type: 'response',
        success: true,
        data: { messages: [wireMsg('x', 'user', 'not ours')] },
      }),
    );
    expect(store.model.messages).toHaveLength(0);
    expect(store.getState().history).toEqual({ phase: 'initial' });
    expect(sent).toHaveLength(1);
  });

  it('drops the skeleton when live frames arrive before any page', () => {
    const { store } = storeWithSentLog();
    store.startHistory();
    store.apply(
      eventBatch(1, 'message_end', {
        type: 'message_end',
        message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
    );
    // Streaming is independent of paging (spec §7.3): rows render, no skeleton.
    expect(store.getState().history).toEqual({ phase: 'idle', hasMore: false });
    expect(store.model.messages).toHaveLength(1);
  });
});

describe('TranscriptStore history lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts an initial page that arrives after the skeleton timeout', () => {
    const { store, sent } = storeWithSentLog();
    store.startHistory();
    const id = sent[0]?.id;

    vi.advanceTimersByTime(10_000);
    expect(store.getState().history).toEqual({ phase: 'idle', hasMore: false });

    store.apply(
      responseBatch(1, {
        id,
        success: true,
        data: { messages: [wireMsg('late', 'user', 'still valid')] },
      }),
    );
    expect(store.model.messages.map((m) => m.id)).toEqual(['late']);
  });

  it('restarts initial paging after dispose and reconnect', () => {
    const { store, sent } = storeWithSentLog();
    store.startHistory();
    store.apply(
      responseBatch(1, {
        id: sent[0]?.id,
        success: true,
        data: { messages: [wireMsg('h1', 'user', 'first session')] },
      }),
    );

    store.dispose();
    store.startHistory();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: 'get_messages_page', limit: 256 });
    expect(sent[1]?.cursor).toBeUndefined();
  });
});
