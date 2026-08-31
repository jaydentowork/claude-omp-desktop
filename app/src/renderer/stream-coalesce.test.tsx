// Headless acceptance for the hot IPC path (issue #7): a fake main-side
// pump posts 10k frames at 60 fps through the real Transport; the renderer
// store (jsdom) must see them coalesced into far fewer delivered batches.

import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePortMain } from 'electron';
import { FLUSH_INTERVAL_MS, Transport } from '../main/transport';
import type { ChatMessage } from '../main/omp-rpc';
import {
  OmpProvider,
  TranscriptStore,
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

/** Build a `message_update` payload matching the on-wire frame shape
 * (`omp-pump` re-emits the raw decoded JSON as the frame payload). */
const updateFrame = (text: string): { kind: string; payload: unknown } => ({
  kind: 'message_update',
  payload: { type: 'message_update', assistantMessageEvent: { partial: { content: [{ type: 'text', text }] } } },
});

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

  it('keeps pre-attach frames without creating a renderer sequence gap', () => {
    const transport = new Transport();
    transport.ingest(updateFrame('before renderer'));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    const { port, bridge } = fakeWiring();
    const store = new TranscriptStore();
    bridge.subscribe(store.apply);
    transport.attach(port);
    transport.ingest(updateFrame('after renderer'));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);

    const state = store.getState();
    expect(state.framesReceived).toBe(2);
    expect(state.lastSeq).toBe(1);
    expect(state.gapDetected).toBe(false);
  });

  it(`delivers ≤ ${MAX_DELIVERED} batches to the store`, () => {
    const { port, bridge } = fakeWiring();
    const transport = new Transport();
    transport.attach(port);

    const store = new TranscriptStore();
    const unsubscribe = bridge.subscribe(store.apply);

    const tickMs = 1000 / FPS;
    let sent = 0;
    let clock = 0;
    while (sent < TOTAL_FRAMES) {
      for (let i = 0; i < FRAMES_PER_TICK && sent < TOTAL_FRAMES; i++, sent++) {
        transport.ingest(updateFrame(`t${sent}`));
      }
      const next = Math.round((clock + 1) * tickMs) - Math.round(clock * tickMs);
      vi.advanceTimersByTime(next);
      clock++;
    }
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
    unsubscribe();

    const state = store.getState();
    expect(state.framesReceived + transport.stats().droppedFrames).toBe(TOTAL_FRAMES);
    expect(state.batchesDelivered).toBeGreaterThan(0);
    expect(state.batchesDelivered).toBeLessThanOrEqual(MAX_DELIVERED);
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
      transport.ingest(updateFrame('a'));
      transport.ingest(updateFrame('b'));
      vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    });

    expect(screen.getByTestId('probe').textContent).toBe('2/1');
  });

  it('reducer keeps the latest message_update on its assistant row', () => {
    const store = new TranscriptStore();
    const batch: StreamBatch = {
      seq: 1,
      frames: [
        updateFrame('stale'),
        updateFrame('fresh'),
        { kind: 'agent_end', payload: { type: 'agent_end', isTerminal: true } },
      ],
    };
    store.apply(batch);
    // The transcript collapsed the 3 frames into a single settled assistant row
    // (per the coalescer: message_update → pending; agent_end → flush + settle).
    // The store exposes the resulting row list, not per-frame state.
    const msgs = store.model.messages.filter(
      (m): m is Extract<ChatMessage, { row: 'text' }> =>
        m.row === 'text' && m.role === 'assistant',
    );
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    // The freshest text is the last applied; earlier message_updates are replaced.
    expect(msgs[msgs.length - 1]?.text).toContain('fresh');
    expect(store.getState().streaming).toBe(false);
  });
});