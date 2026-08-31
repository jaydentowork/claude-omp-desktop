// Snapshot-not-delta semantics of `message_update` (docs/rpc-events.md §2)
// and the coalescer's four ordering rules. Ports the Rust model.rs tests.

import { describe, expect, it } from 'vitest';
import { Coalescer, decodeEvent, TranscriptModel, type TranscriptEvent } from '../transcript';

const upd = (id: string, text: string): TranscriptEvent => ({
  event: 'message_update',
  id,
  text,
});

describe('snapshot-not-delta', () => {
  it('message_update replaces rather than appends', () => {
    // If updates were treated as deltas the result would be
    // "HelHelloHello, world".
    const m = new TranscriptModel();
    m.apply({ event: 'message_start', id: 'a', role: 'assistant' });
    m.apply(upd('a', 'Hel'));
    m.apply(upd('a', 'Hello'));
    m.apply(upd('a', 'Hello, world'));

    expect(m.messages).toHaveLength(1);
    const row = m.messages[0];
    expect(row.row).toBe('text');
    if (row.row !== 'text') return;
    expect(row.text).toBe('Hello, world');
  });

  it('decodeEvent prefers assistantMessageEvent.partial over the outer message', () => {
    const line = JSON.stringify({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'outer' }] },
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'x',
        partial: { role: 'assistant', content: [{ type: 'text', text: 'inner snapshot' }] },
      },
    });
    const e = decodeEvent(line);
    expect(e.event).toBe('message_update');
    if (e.event !== 'message_update') return;
    expect(e.text).toBe('inner snapshot');
  });

  it('agent_end with isTerminal:false keeps the transcript streaming', () => {
    const m = new TranscriptModel();
    m.apply({ event: 'agent_start' });
    m.apply({ event: 'message_start', id: 'a', role: 'assistant' });
    m.apply({ event: 'agent_end', isTerminal: false });
    expect(m.streaming).toBe(true);
    expect(m.streamingIndex()).not.toBeNull();

    m.apply({ event: 'agent_end', isTerminal: true });
    expect(m.streaming).toBe(false);
    expect(m.streamingIndex()).toBeNull();
  });
});

describe('coalescer ordering contract', () => {
  it('rule 1: a later update supersedes the pending one', () => {
    const c = new Coalescer();
    expect(c.feed(upd('a', 'one'))).toHaveLength(0);
    expect(c.feed(upd('a', 'one two'))).toHaveLength(0);
    const flushed = c.flush();
    expect(flushed).not.toBeNull();
    if (flushed?.event !== 'message_update') return;
    expect(flushed.text).toBe('one two');
  });

  it('rule 2: message_end drops the pending update', () => {
    const c = new Coalescer();
    c.feed(upd('a', 'partial'));
    const out = c.feed({ event: 'message_end', id: 'a', role: 'assistant', text: 'final' });
    expect(out).toHaveLength(1);
    expect(out[0].event).toBe('message_end');
    expect(c.hasPending()).toBe(false);
  });

  it('rule 3: any other event flushes the pending update first', () => {
    // Getting this wrong renders a tool call above the text that preceded it.
    const c = new Coalescer();
    c.feed(upd('a', 'text before tool'));
    const out = c.feed({ event: 'tool_start', toolCallId: 't1', name: 'bash', summary: 'ls' });
    expect(out.map((e) => e.event)).toEqual(['message_update', 'tool_start']);
  });

  it('rule 4: reset drops pending without flushing', () => {
    const c = new Coalescer();
    c.feed(upd('a', 'doomed'));
    c.reset();
    expect(c.flush()).toBeNull();
    expect(c.flushes).toBe(0);
  });
});
