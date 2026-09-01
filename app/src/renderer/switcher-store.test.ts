// Switcher acceptance (docs/model-thinking-switcher.md §8): the model path
// is optimistic (paint on commit, revert on failure, events win), the
// thinking path is event-driven (label follows thinking_level_changed,
// never the click). Headless, mock transport in the batch-envelope shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptStore } from './omp-provider';
import { RpcClient } from './rpc-client';
import { SwitcherStore, displayLevel } from './switcher-store';

const batchOf = (() => {
  let seq = 0;
  return (frames: Array<{ kind: string; payload: unknown }>) => ({ seq: ++seq, frames });
})();

/** Nth command of a type sent upstream; throws instead of `!`-asserting. */
function cmd(sent: readonly Record<string, unknown>[], type: string, nth = 0): Record<string, unknown> {
  const found = sent.filter((c) => c.type === type)[nth];
  if (found === undefined) throw new Error(`no ${type} command sent`);
  return found;
}

function wired() {
  const transcript = new TranscriptStore();
  const sent: Array<Record<string, unknown>> = [];
  transcript.send = (c) => sent.push(c as Record<string, unknown>);
  const rpc = new RpcClient(transcript);
  const store = new SwitcherStore();
  store.attach(transcript, rpc);
  const respond = (req: Record<string, unknown>, over: Partial<{ success: boolean; data: unknown; error: string }>) =>
    transcript.apply(
      batchOf([
        {
          kind: 'response',
          payload: { id: req.id, command: req.type, success: true, ...over },
        },
      ]),
    );
  return { transcript, rpc, store, sent, respond };
}

const luna = { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna', provider: 'openai' };
const terra = { id: 'gpt-terra-sonnet', name: 'GPT Terra - Sonnet', provider: 'openai' };

describe('model path (optimistic + reconcile)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('1. optimistic paint: label shows the new name before any response and after success', async () => {
    const { store, sent, respond } = wired();
    void store.setModel(luna);
    expect(store.getState().modelLabel).toBe('GPT 5.6 Luna');

    const req = cmd(sent, 'set_model');
    expect(req).toMatchObject({ provider: 'openai', modelId: 'gpt-5.6-luna' });
    respond(req, { success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().modelLabel).toBe('GPT 5.6 Luna');
  });

  it('2. failure reverts the label and shows the exact error string', async () => {
    const { store, sent, respond } = wired();
    // Establish a confirmed label first.
    void store.setModel(terra);
    respond(cmd(sent, 'set_model'), { success: true });
    await vi.advanceTimersByTimeAsync(0);

    void store.setModel(luna);
    expect(store.getState().modelLabel).toBe('GPT 5.6 Luna');
    const req = cmd(sent, 'set_model', 1);
    respond(req, { success: false, error: 'Model not found: provider/model' });
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().modelLabel).toBe('GPT Terra - Sonnet');
    expect(store.getState().notice).toBe('Model not found: provider/model');
    // Notice clears after 6 s.
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.getState().notice).toBeNull();
  });

  it('3. config_update wins over a pending optimistic paint', async () => {
    const { transcript, store } = wired();
    void store.setModel(luna); // response never arrives — pending
    transcript.apply(
      batchOf([
        {
          kind: 'config_update',
          payload: { type: 'config_update', model: { name: 'GPT Terra - Sonnet' }, thinkingLevel: 'high' },
        },
      ]),
    );
    expect(store.getState().modelLabel).toBe('GPT Terra - Sonnet');
    expect(store.getState().thinkingLevel).toBe('high');
    // A late failure for the superseded set_model must NOT revert the event's
    // label (pending cleared by the event).
  });

  it('4. model_changed re-arms: get_state goes out and its model lands on the label', async () => {
    const { transcript, store, sent, respond } = wired();
    transcript.apply(batchOf([{ kind: 'model_changed', payload: { type: 'model_changed' } }]));
    await vi.advanceTimersByTimeAsync(0);
    const req = cmd(sent, 'get_state');
    respond(req, { success: true, data: { model: { name: 'GPT 5.6 Luna' }, thinkingLevel: 'medium' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().modelLabel).toBe('GPT 5.6 Luna');
    expect(store.getState().thinkingLevel).toBe('medium');
  });

  it('catalog failure surfaces the retry notice and reports false', async () => {
    const { store, sent, respond } = wired();
    const p = store.refreshCatalog();
    respond(cmd(sent, 'get_available_models'), {
      success: false,
      error: 'nope',
    });
    await expect(p).resolves.toBe(false);
    expect(store.getState().notice).toBe('Models unavailable · click to retry');
  });

  it('catalog success stores name/provider/id in server order', async () => {
    const { store, sent, respond } = wired();
    const p = store.refreshCatalog();
    respond(cmd(sent, 'get_available_models'), {
      success: true,
      data: { models: [terra, luna] },
    });
    await expect(p).resolves.toBe(true);
    expect(store.getState().catalog.map((m) => m.name)).toEqual([
      'GPT Terra - Sonnet',
      'GPT 5.6 Luna',
    ]);
  });
});

describe('thinking path (event-driven, no optimistic paint)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('5. label unchanged on send; follows thinking_level_changed; resolved beats configured', async () => {
    const { transcript, store, sent, respond } = wired();
    const p = store.setThinkingLevel('high');
    expect(store.getState().thinkingLevel).toBeNull(); // not painted by the click

    respond(cmd(sent, 'set_thinking_level'), { success: true });
    await expect(p).resolves.toBe(true);
    expect(store.getState().thinkingLevel).toBeNull(); // still event-driven

    transcript.apply(
      batchOf([
        {
          kind: 'thinking_level_changed',
          payload: { type: 'thinking_level_changed', thinkingLevel: 'high' },
        },
      ]),
    );
    expect(store.getState().thinkingLevel).toBe('high');

    // configured/resolved override: resolved wins.
    transcript.apply(
      batchOf([
        {
          kind: 'thinking_level_changed',
          payload: {
            type: 'thinking_level_changed',
            thinkingLevel: 'high',
            configured: 'high',
            resolved: 'medium',
          },
        },
      ]),
    );
    expect(store.getState().thinkingLevel).toBe('medium');
  });

  it('failure notices and resolves false so the picker stays open', async () => {
    const { store, sent, respond } = wired();
    const p = store.setThinkingLevel('max');
    respond(cmd(sent, 'set_thinking_level'), {
      success: false,
      error: 'no',
    });
    await expect(p).resolves.toBe(false);
    expect(store.getState().notice).toBe('no');
  });
});

describe('dead child (spec §2.4)', () => {
  it('the synthesized exit notice dims the cluster and no-ops commits', async () => {
    const { transcript, store, sent } = wired();
    transcript.apply(
      batchOf([
        {
          kind: 'notice',
          payload: {
            level: 'error',
            message: 'The omp process for this session exited unexpectedly: boom',
          },
        },
      ]),
    );
    expect(store.getState().alive).toBe(false);
    await store.setModel(luna);
    expect(sent.find((c) => c.type === 'set_model')).toBeUndefined();
  });
});

describe('displayLevel', () => {
  it('capitalizes', () => {
    expect(displayLevel('xhigh')).toBe('Xhigh');
    expect(displayLevel('off')).toBe('Off');
  });
});
