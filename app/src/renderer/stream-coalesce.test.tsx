// Headless acceptance for the hot IPC path (issue #7): a fake main-side
// pump posts 10k frames at 60 fps through the real Transport; the renderer
// store (jsdom) must see them coalesced into far fewer delivered batches.

import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePortMain } from 'electron';
import { FLUSH_INTERVAL_MS, Transport } from '../main/transport';
import {
  OmpProvider,
  StreamStore,
  useOmpStream,
  type OmpBridge,
  type StreamBatch,
} from './omp-provider';

// Tell React 18 this jsdom env supports act() (testing-library sets this in
// its setup file, which this project doesn't use).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOTAL_FRAMES = 10_000;const FPS = 60;
// omp emits far above display rate: ~960 frames/s into a 60 fps flush clock.
// 10k frames over 625 ticks → at most one batch per tick → ≤ 700 batches.
const FRAMES_PER_TICK = 16;
const MAX_DELIVERED = 700;

/** Bridge + port mock: Transport's port1.postMessage lands in subscribers
 * synchronously, like the preload relay does. */
function fakeWiring() {
  const listeners = new Set<(batch: unknown) => void>();
  const port = {
    postMessage: (data: unknown) => {
      for (const cb of listeners) cb(data);
    },
    on: () => undefined,
    close: () => undefined,
  } as unknown as MessagePortMain;
  const bridge: OmpBridge = {
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    send() {
      /* upstream unused in this test */
    },
  };
  return { port, bridge };
}

describe('main → renderer coalescing (10k frames at 60 fps)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it(`delivers ≤ ${MAX_DELIVERED} batches to the store`, () => {
    const { port, bridge } = fakeWiring();
    const transport = new Transport();
    transport.attach(port);

    const store = new StreamStore();
    const unsubscribe = bridge.subscribe(store.apply);

    // 60 fps pump: each ~16.67ms tick ingests a burst of frames, i.e. omp
    // emitting message_update far above display rate.
    const tickMs = 1000 / FPS;
    let sent = 0;
    let clock = 0;
    while (sent < TOTAL_FRAMES) {
      for (let i = 0; i < FRAMES_PER_TICK && sent < TOTAL_FRAMES; i++, sent++) {
        transport.ingest({ kind: 'message_update', payload: sent });
      }
      const next = Math.round((clock + 1) * tickMs) - Math.round(clock * tickMs);
      vi.advanceTimersByTime(next);
      clock++;
    }
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2); // drain the tail
    unsubscribe();

    const state = store.getState();
    expect(state.framesReceived + transport.stats().droppedFrames).toBe(TOTAL_FRAMES);
    expect(state.batchesDelivered).toBeGreaterThan(0);
    expect(state.batchesDelivered).toBeLessThanOrEqual(MAX_DELIVERED);
    // Sequence continuity: nothing lost between Transport and the store.
    expect(state.lastSeq).toBe(state.batchesDelivered);
  });

  it('renders frame counts through <OmpProvider> + useOmpStream', () => {
    const { port, bridge } = fakeWiring();
    const transport = new Transport();
    transport.attach(port);

    function Probe() {
      const { framesReceived, batchesDelivered } = useOmpStream();
      return <div data-testid="probe">{`${framesReceived}/${batchesDelivered}`}</div>;
    }
    render(
      <OmpProvider bridge={bridge}>
        <Probe />
      </OmpProvider>,
    );

    act(() => {
      transport.ingest({ kind: 'message_update', payload: 'a' });
      transport.ingest({ kind: 'message_update', payload: 'b' });
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    });

    expect(screen.getByTestId('probe').textContent).toBe('2/1');
  });

  it('reducer keeps the latest frame per kind', () => {
    const store = new StreamStore();
    const batch: StreamBatch = {
      seq: 1,
      frames: [
        { kind: 'message_update', payload: 'stale' },
        { kind: 'message_update', payload: 'fresh' },
        { kind: 'agent_end', payload: null },
      ],
    };
    store.apply(batch);
    const state = store.getState();
    expect(state.latestByKind.get('message_update')?.payload).toBe('fresh');
    expect(state.latestByKind.has('agent_end')).toBe(true);
  });
});
