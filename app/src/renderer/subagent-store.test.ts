// Subagent store acceptance (docs/subagent-panel.md §1–§3, §6–§7):
// lifecycle frames create rows and move them between groups, progress frames
// update counters per-card, get_subagents seeds, finished rows are retained
// client-side and cleared locally, and the elapsed ticker mounts only while
// a card runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptStore } from './omp-provider';
import { RpcClient } from './rpc-client';
import { SubagentStore, formatDuration, formatTokens } from './subagent-store';

const batchOf = (() => {
  let seq = 0;
  return (frames: Array<{ kind: string; payload: unknown }>) => ({ seq: ++seq, frames });
})();

function lifecycle(id: string, status: string, extra?: Record<string, unknown>) {
  return {
    kind: 'subagent_lifecycle',
    payload: { type: 'subagent_lifecycle', payload: { id, agent: 'scout', status, ...extra } },
  };
}

function progress(id: string, status: string, over?: Record<string, unknown>) {
  return {
    kind: 'subagent_progress',
    payload: {
      type: 'subagent_progress',
      payload: {
        agent: 'scout',
        task: 'find the bug',
        progress: {
          id,
          status,
          task: 'find the bug',
          toolCount: 8,
          tokens: 67_100,
          cost: 0.5,
          durationMs: 55_000,
          ...over,
        },
      },
    },
  };
}

function wiredStore() {
  const transcript = new TranscriptStore();
  const rpc = new RpcClient(transcript);
  const store = new SubagentStore();
  const detach = store.attach(transcript, rpc);
  return { transcript, rpc, store, detach };
}

const findCmd = (
  sent: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown> => {
  const c = sent.find((x) => x.type === type);
  if (c === undefined) throw new Error(`no ${type} command sent`);
  return c;
};

describe('SubagentStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lifecycle started creates a Running row; terminal moves it to Finished in place', () => {
    const { transcript, store } = wiredStore();
    transcript.apply(batchOf([lifecycle('a1', 'started', { description: 'scan repo' })]));
    expect(store.getGroups().running).toEqual(['a1']);
    expect(store.getRow('a1')?.status).toBe('running');

    transcript.apply(batchOf([lifecycle('a1', 'completed')]));
    // Retained client-side: get_subagents DELETES finished entries server-side.
    expect(store.getGroups().running).toEqual([]);
    expect(store.getGroups().finished).toEqual(['a1']);
    expect(store.getRow('a1')?.status).toBe('completed');
  });

  it('progress frames update counters without changing group membership', () => {
    const { transcript, store } = wiredStore();
    const panelNotify = vi.fn();
    transcript.apply(batchOf([lifecycle('a1', 'started')]));
    store.subscribe(panelNotify);

    const rowNotify = vi.fn();
    store.subscribeRow('a1', rowNotify);
    transcript.apply(batchOf([progress('a1', 'running')]));

    expect(store.getRow('a1')?.lastProgress?.tokens).toBe(67_100);
    expect(rowNotify).toHaveBeenCalled();
    // Panel-level listeners hear membership changes only (spec §6).
    expect(panelNotify).not.toHaveBeenCalled();
  });

  it('orders Running newest-first by group entry, Finished newest-first by terminal time', () => {
    const { transcript, store } = wiredStore();
    transcript.apply(batchOf([lifecycle('a1', 'started')]));
    vi.advanceTimersByTime(10);
    transcript.apply(batchOf([lifecycle('a2', 'started')]));
    expect(store.getGroups().running).toEqual(['a2', 'a1']);

    // a1 finishes first, then a2 — newest terminal first.
    vi.advanceTimersByTime(10);
    transcript.apply(batchOf([lifecycle('a1', 'failed')]));
    vi.advanceTimersByTime(10);
    transcript.apply(batchOf([lifecycle('a2', 'completed')]));
    expect(store.getGroups().finished).toEqual(['a2', 'a1']);
  });

  it('Clear removes finished rows only, locally', () => {
    const { transcript, store } = wiredStore();
    transcript.apply(
      batchOf([lifecycle('a1', 'started'), lifecycle('a2', 'started'), lifecycle('a2', 'aborted')]),
    );
    store.clearFinished();
    expect(store.getGroups().running).toEqual(['a1']);
    expect(store.getGroups().finished).toEqual([]);
  });

  it('progress before any lifecycle frame creates the row defensively', () => {
    const { transcript, store } = wiredStore();
    transcript.apply(batchOf([progress('ghost', 'running')]));
    expect(store.getGroups().running).toEqual(['ghost']);
    expect(store.getRow('ghost')?.agentName).toBe('scout');
  });

  it('a stale progress frame never resurrects a terminal row', () => {
    const { transcript, store } = wiredStore();
    transcript.apply(batchOf([lifecycle('a1', 'started'), lifecycle('a1', 'completed')]));
    transcript.apply(batchOf([progress('a1', 'running')]));
    expect(store.getRow('a1')?.status).toBe('completed');
    expect(store.getGroups().finished).toEqual(['a1']);
  });

  it('elapsed ticker runs only while a card is running and bumps row revs', () => {
    const { transcript, store } = wiredStore();
    transcript.apply(batchOf([lifecycle('a1', 'started')]));
    const rowNotify = vi.fn();
    store.subscribeRow('a1', rowNotify);

    vi.advanceTimersByTime(3000);
    expect(rowNotify.mock.calls.length).toBeGreaterThanOrEqual(3);

    transcript.apply(batchOf([lifecycle('a1', 'completed')]));
    rowNotify.mockClear();
    vi.advanceTimersByTime(5000);
    // Ticker unmounted: a quiet panel's overhead is zero (spec §6).
    expect(rowNotify).not.toHaveBeenCalled();
  });

  it('elapsed combines server durationMs with local time since the frame', () => {
    const { transcript, store } = wiredStore();
    transcript.apply(batchOf([progress('a1', 'running')]));
    vi.advanceTimersByTime(2000);
    const row = store.getRow('a1');
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('expected row');
    expect(store.elapsedMs(row)).toBe(57_000); // 55s server + 2s local
  });

  it('startup: subscribes at progress level and seeds from get_subagents', async () => {
    const transcript = new TranscriptStore();
    const sent: Array<Record<string, unknown>> = [];
    transcript.send = (c) => sent.push(c as Record<string, unknown>);
    const rpc = new RpcClient(transcript);
    const store = new SubagentStore();
    store.attach(transcript, rpc);

    transcript.apply(batchOf([{ kind: 'ready', payload: { protocolVersion: 1 } }]));
    await vi.advanceTimersByTimeAsync(0);
    const sub = findCmd(sent, 'set_subagent_subscription');
    expect(sub).toMatchObject({ level: 'progress' });

    // Respond to the subscription; the seeding get_subagents follows.
    transcript.apply(
      batchOf([
        {
          kind: 'response',
          payload: { id: sub.id, command: 'set_subagent_subscription', success: true },
        },
      ]),
    );
    await vi.advanceTimersByTimeAsync(0);
    const roster = findCmd(sent, 'get_subagents');
    transcript.apply(
      batchOf([
        {
          kind: 'response',
          payload: {
            id: roster.id,
            command: 'get_subagents',
            success: true,
            data: { subagents: [{ id: 's1', agent: 'seed', status: 'started' }] },
          },
        },
      ]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getGroups().running).toEqual(['s1']);
  });

  it('older builds without the subscription degrade to unsupported, not a crash', async () => {
    const transcript = new TranscriptStore();
    const sent: Array<Record<string, unknown>> = [];
    transcript.send = (c) => sent.push(c as Record<string, unknown>);
    const rpc = new RpcClient(transcript);
    const store = new SubagentStore();
    store.attach(transcript, rpc);

    transcript.apply(batchOf([{ kind: 'ready', payload: { protocolVersion: 1 } }]));
    await vi.advanceTimersByTimeAsync(0);
    // Unknown command answers with id: undefined — the request times out.
    findCmd(sent, 'set_subagent_subscription');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(store.isSupported).toBe(false);
  });
});

describe('formatting (rpc-events.md §3.3 reference)', () => {
  it('tokens: k suffix, 1 dp until three digits (67.1k matches the screenshot)', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(9_940)).toBe('9.9k');
    expect(formatTokens(67_100)).toBe('67.1k');
    expect(formatTokens(150_000)).toBe('150k');
  });

  it('duration: empty under 1 s, Ns under a minute, Nm above', () => {
    expect(formatDuration(800)).toBe('');
    expect(formatDuration(55_000)).toBe('55s');
    expect(formatDuration(150_000)).toBe('2m');
  });
});
