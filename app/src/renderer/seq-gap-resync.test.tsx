// Headless acceptance for seq-gap detection + resync (issue #13): a batch
// seq gap (drop-oldest overflow in main's Transport) must set gapDetected,
// never auto-issue a command, and clear once resync() re-requests state.

import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  OmpProvider,
  ResyncBanner,
  TranscriptStore,
  type OmpBridge,
} from './omp-provider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const batch = (seq: number) => ({
  seq,
  frames: [{ kind: 'message_update', payload: seq }],
});

describe('seq-gap detection', () => {
  it('flags gapDetected on non-contiguous batches, no side effects', () => {
    const send = vi.fn();
    const store = new TranscriptStore();
    store.send = send;

    store.apply(batch(1));
    expect(store.getState().gapDetected).toBe(false);

    store.apply(batch(3)); // seq 2 dropped
    expect(store.getState().gapDetected).toBe(true);
    // No surprise side effects: nothing sent without an explicit resync().
    expect(send).not.toHaveBeenCalled();
  });

  it('stays flagged across later contiguous batches until resync', () => {
    const store = new TranscriptStore();
    store.apply(batch(1));
    store.apply(batch(3));
    store.apply(batch(4)); // contiguous again — gap already happened
    expect(store.getState().gapDetected).toBe(true);
  });

  it('resync() sends get_state and clears the flag', () => {
    const send = vi.fn();
    const store = new TranscriptStore();
    store.send = send;
    store.apply(batch(1));
    store.apply(batch(3));

    store.resync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ op: 'get_state' });
    expect(store.getState().gapDetected).toBe(false);
  });
});

describe('<ResyncBanner>', () => {
  it('shows on gap and issues exactly one get_state', () => {
    const send = vi.fn();
    let deliver: (batch: unknown) => void = () => undefined;
    const bridge: OmpBridge = {
      subscribe(cb) {
        deliver = cb;
        return () => undefined;
      },
      send,
    };
    render(
      <OmpProvider bridge={bridge}>
        <ResyncBanner />
      </OmpProvider>,
    );

    act(() => deliver(batch(1)));
    expect(screen.queryByRole('status')).toBeNull();
    expect(send).not.toHaveBeenCalled();

    act(() => deliver(batch(5)));
    expect(screen.getByRole('status').textContent).toBe(
      'stream gap detected, re-reading state',
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ op: 'get_state' });
  });
});
