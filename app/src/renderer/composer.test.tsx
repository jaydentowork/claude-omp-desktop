// Composer slice acceptance (issue #23): renders at the pane foot, submit
// posts upstream via the bridge (`steer` while streaming, `follow_up`
// otherwise — docs/rpc-events.md §4.3), and the local streaming state is
// visible in the placeholder + data attribute.

import { cleanup, fireEvent, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './composer';
import { OmpProvider, type OmpBridge } from './omp-provider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderComposer() {
  const send = vi.fn();
  const listeners = new Set<(batch: unknown) => void>();
  const bridge: OmpBridge = {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    send,
  };
  const utils = render(
    <OmpProvider bridge={bridge}>
      <Composer />
    </OmpProvider>,
  );
  const emit = (frames: Array<{ kind: string; payload: unknown }>) =>
    act(() => {
      for (const cb of listeners) cb({ seq: 1, frames });
    });
  return { send, emit, ...utils };
}

// Same envelope the main-process pump produces: `payload` is the raw RPC
// event (decodeEventValue reads its `type`).
const startStreaming = { kind: 'agent_start', payload: { type: 'agent_start' } };

function submitForm(input: HTMLElement): void {
  const form = input.closest('form');
  if (form === null) throw new Error('composer form missing');
  fireEvent.submit(form);
}

describe('composer', () => {
  afterEach(() => cleanup());

  it('renders input with placeholder and a disabled submit', () => {
    const { getByLabelText } = renderComposer();
    const input = getByLabelText('Prompt') as HTMLInputElement;
    expect(input.placeholder).toBe('Write a prompt…');
    expect((getByLabelText('Send prompt') as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits follow_up when idle and clears the input', () => {
    const { send, getByLabelText } = renderComposer();
    const input = getByLabelText('Prompt') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  hello there  ' } });
    submitForm(input);
    expect(send).toHaveBeenCalledWith({ type: 'follow_up', message: 'hello there' });
    expect(input.value).toBe('');
  });

  it('submits steer while streaming and shows the streaming state', () => {
    const { send, emit, getByLabelText, container } = renderComposer();
    emit([startStreaming]);
    const input = getByLabelText('Prompt') as HTMLInputElement;
    expect(input.placeholder).toBe('Steer the agent…');
    expect(container.querySelector('.composer')?.getAttribute('data-streaming')).toBe(
      'true',
    );
    fireEvent.change(input, { target: { value: 'go left' } });
    submitForm(input);
    expect(send).toHaveBeenCalledWith({ type: 'steer', message: 'go left' });
  });

  it('never posts an empty or whitespace-only message', () => {
    const { send, getByLabelText } = renderComposer();
    const input = getByLabelText('Prompt') as HTMLInputElement;
    submitForm(input);
    fireEvent.change(input, { target: { value: '   ' } });
    submitForm(input);
    // Provider mounts kick off the initial history page (§7.1) — only
    // composer submits should be absent.
    const composerCalls = send.mock.calls.filter(
      ([arg]) => (arg as { type?: string }).type === 'steer' || (arg as { type?: string }).type === 'follow_up',
    );
    expect(composerCalls).toHaveLength(0);
  });
});

// TranscriptStore.send is null until the bridge attaches — submit before
// wiring must not throw (the optional-call path).
describe('composer without a bridge', () => {
  afterEach(() => cleanup());

  it('submit is a no-op, not a crash', () => {
    const { getByLabelText } = render(
      <OmpProvider bridge={undefined}>
        <Composer />
      </OmpProvider>,
    );
    const input = getByLabelText('Prompt') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hi' } });
    expect(() => submitForm(input)).not.toThrow();
  });
});
