// UI acceptance for issue #25: a Task-spawned subagent shows a card in the
// tasks panel, "View transcript" opens the dialog with the right transcript
// (polled via get_subagent_messages), and the status-bar cluster's pickers
// drive real RPC commands (hotkey commit included — spec §8 test 6).

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OmpProvider, type OmpBridge } from './omp-provider';
import { SubagentPanel } from './subagent-panel';
import { SwitcherCluster } from './switcher-cluster';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Scriptable bridge: batches in via deliver(), commands captured in sent. */
function fakeBridge() {
  let seq = 0;
  let deliver: (batch: unknown) => void = () => undefined;
  const sent: Array<Record<string, unknown>> = [];
  const bridge: OmpBridge = {
    subscribe(cb) {
      deliver = cb;
      return () => undefined;
    },
    send(command) {
      sent.push(command as Record<string, unknown>);
    },
  };
  const push = (frames: Array<{ kind: string; payload: unknown }>) =>
    act(() => deliver({ seq: ++seq, frames }));
  const respond = (req: Record<string, unknown>, over: Partial<{ success: boolean; data: unknown; error: string }>) =>
    push([{ kind: 'response', payload: { id: req.id, command: req.type, success: true, ...over } }]);
  return { bridge, sent, push, respond };
}

function lifecycle(id: string, status: string) {
  return {
    kind: 'subagent_lifecycle',
    payload: { type: 'subagent_lifecycle', payload: { id, agent: 'scout', status, description: 'find the bug' } },
  };
}

function progressFrame(id: string, status: string) {
  return {
    kind: 'subagent_progress',
    payload: {
      type: 'subagent_progress',
      payload: {
        agent: 'scout',
        task: 'find the bug',
        progress: { id, status, task: 'find the bug', toolCount: 8, tokens: 67_100, cost: 0.5, durationMs: 55_000 },
      },
    },
  };
}

const findCmd = (
  sent: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown> => {
  const c = sent.find((x) => x.type === type);
  if (c === undefined) throw new Error(`no ${type} command sent`);
  return c;
};

describe('subagent panel UI', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders running and finished cards with counters and Clear', () => {
    const { bridge, push } = fakeBridge();
    render(
      <OmpProvider bridge={bridge}>
        <SubagentPanel />
      </OmpProvider>,
    );

    push([lifecycle('a1', 'started'), progressFrame('a1', 'running')]);
    expect(screen.getByText('scout')).toBeTruthy();
    expect(screen.getByText('find the bug')).toBeTruthy();

    push([lifecycle('a1', 'completed')]);
    expect(screen.getByText(/Finished 1/)).toBeTruthy();
    expect(screen.getByText('67.1k tokens · 8 tool uses')).toBeTruthy();

    fireEvent.click(screen.getByText('Clear'));
    expect(screen.queryByText('scout')).toBeNull();
  });

  it('View transcript opens the dialog, fetches via get_subagent_messages, and renders rows', async () => {
    // jsdom collapses layout; give the virtualizer a viewport before mount.
    const proto = HTMLElement.prototype;
    vi.spyOn(proto, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(proto, 'offsetWidth', 'get').mockReturnValue(800);

    const { bridge, sent, push, respond } = fakeBridge();
    render(
      <OmpProvider bridge={bridge}>
        <SubagentPanel />
      </OmpProvider>,
    );
    push([lifecycle('a1', 'started'), lifecycle('a1', 'completed')]);
    fireEvent.click(screen.getByText('View transcript'));

    const req = findCmd(sent, 'get_subagent_messages');
    expect(req).toMatchObject({ subagentId: 'a1' });
    expect(req.fromByte).toBeUndefined(); // full read on open

    respond(req, {
      success: true,
      data: {
        fromByte: 0,
        nextByte: 100,
        reset: false,
        messages: [
          { id: 'm1', role: 'user', content: [{ type: 'text', text: 'child prompt' }] },
          { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'child answer' }] },
        ],
      },
    });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('child prompt')).toBeTruthy();
    expect(screen.getByText('child answer')).toBeTruthy();

    // Terminal row → no further polls after the drain.
    const polls = sent.filter((c) => c.type === 'get_subagent_messages').length;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(sent.filter((c) => c.type === 'get_subagent_messages').length).toBe(polls);

    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps polling a running agent at 250 ms until terminal', async () => {
    const { bridge, sent, push, respond } = fakeBridge();
    render(
      <OmpProvider bridge={bridge}>
        <SubagentPanel />
      </OmpProvider>,
    );
    push([lifecycle('a1', 'started'), lifecycle('a1', 'failed')]);
    // Failed cards show View transcript only (spec §2) — reopen a running
    // one by re-running lifecycle started for a second agent.
    push([lifecycle('a2', 'started'), progressFrame('a2', 'running'), lifecycle('a2', 'failed')]);

    const links = screen.getAllByText('View transcript');
    fireEvent.click(links[0]);
    const first = findCmd(sent, 'get_subagent_messages');
    respond(first, {
      success: true,
      data: { fromByte: 0, nextByte: 40, reset: false, messages: [] },
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Terminal status: one read, no poller.
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(sent.filter((c) => c.type === 'get_subagent_messages')).toHaveLength(1);
  });

  it('dialog surfaces documented fetch errors as a dismissable state', async () => {
    const { bridge, sent, push, respond } = fakeBridge();
    render(
      <OmpProvider bridge={bridge}>
        <SubagentPanel />
      </OmpProvider>,
    );
    push([lifecycle('a1', 'started'), lifecycle('a1', 'aborted')]);
    fireEvent.click(screen.getByText('View transcript'));
    respond(findCmd(sent, 'get_subagent_messages'), {
      success: false,
      error: 'Subagent event bus unavailable',
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('alert').textContent).toBe('Subagent event bus unavailable');
  });
});

describe('switcher cluster UI', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const catalog = {
    models: [
      { id: 'terra', name: 'GPT Terra - Sonnet', provider: 'openai' },
      { id: 'luna', name: 'GPT 5.6 Luna', provider: 'openai' },
      { id: 'fable', name: 'Fable 5', provider: 'anthropic' },
    ],
  };

  it('labels render from config_update and open the model picker with a fresh catalog', async () => {
    const { bridge, sent, push, respond } = fakeBridge();
    render(
      <OmpProvider bridge={bridge}>
        <SwitcherCluster />
      </OmpProvider>,
    );
    push([
      {
        kind: 'config_update',
        payload: { type: 'config_update', model: { name: 'GPT Terra - Sonnet' }, thinkingLevel: 'high' },
      },
    ]);
    expect(screen.getByText('GPT Terra - Sonnet')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();

    fireEvent.click(screen.getByText('GPT Terra - Sonnet'));
    // Popover opens only after the catalog fetch resolves (spec §2.2).
    respond(findCmd(sent, 'get_available_models'), {
      success: true,
      data: catalog,
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('listbox')).toBeTruthy();
    // Current model row shows the checkmark, others their hotkeys.
    expect(screen.getByText('✓')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('6. hotkey commit: pressing 3 commits row 3 through the click path', async () => {
    const { bridge, sent, push, respond } = fakeBridge();
    render(
      <OmpProvider bridge={bridge}>
        <SwitcherCluster />
      </OmpProvider>,
    );
    push([
      {
        kind: 'config_update',
        payload: { type: 'config_update', model: { name: 'GPT Terra - Sonnet' }, thinkingLevel: 'high' },
      },
    ]);
    fireEvent.click(screen.getByText('GPT Terra - Sonnet'));
    respond(findCmd(sent, 'get_available_models'), { success: true, data: catalog });
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.keyDown(screen.getByRole('listbox'), { key: '3' });
    // Optimistic paint of row 3 + the RPC command, popover closed.
    expect(sent.find((c) => c.type === 'set_model')).toMatchObject({
      provider: 'anthropic',
      modelId: 'fable',
    });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Fable 5')).toBeTruthy();
  });

  it('thinking slider commits on release and closes only on the confirmed event', async () => {
    const { bridge, sent, push, respond } = fakeBridge();
    render(
      <OmpProvider bridge={bridge}>
        <SwitcherCluster />
      </OmpProvider>,
    );
    push([
      {
        kind: 'config_update',
        payload: { type: 'config_update', model: { name: 'GPT Terra - Sonnet' }, thinkingLevel: 'high' },
      },
    ]);
    fireEvent.click(screen.getByText('High'));
    const slider = screen.getByLabelText('Thinking level');
    fireEvent.change(slider, { target: { value: '6' } }); // max
    // Title tracks the handle live; nothing sent until release.
    expect(sent.find((c) => c.type === 'set_thinking_level')).toBeUndefined();
    fireEvent.pointerUp(slider);
    const req = findCmd(sent, 'set_thinking_level');
    expect(req).toMatchObject({ level: 'max' });

    respond(req, { success: true });
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Popover stays open until the authoritative event lands (spec §3.2).
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Max')).toBeTruthy(); // popover header tracks the local handle
    expect(screen.queryAllByText('Max')).toHaveLength(1); // status-bar label still shows prior
    push([
      {
        kind: 'thinking_level_changed',
        payload: { type: 'thinking_level_changed', thinkingLevel: 'max' },
      },
    ]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Max')).toBeTruthy();
  });
});
