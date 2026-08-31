// Acceptance for the first renderer slice (issue #20): replay the recorded
// capture through the real pipeline — FrameDecoder → Transport → preload-shaped
// bridge → TranscriptStore — with no live `omp`, and assert the row mapping
// the pane renders. The spawn-less fixture pump mirrors OmpPump.toOutbound.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePortMain } from 'electron';
import { FLUSH_INTERVAL_MS, Transport } from '../main/transport';
import { FrameDecoder, type Frame } from '../main/omp-rpc';
import { OmpProvider, TranscriptStore, type OmpBridge } from './omp-provider';
import { TranscriptPane } from './transcript-pane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = readFileSync(
  join(__dirname, '../../../assets/fixtures/streaming-capture.ndjson'),
  'utf8',
);

/** Mirrors OmpPump.toOutbound: raw decoded JSON rides as the frame payload. */
function toOutbound(frame: Frame): { kind: string; payload: unknown } {
  if (frame.kind === 'ready') return { kind: 'ready', payload: frame.ready };
  if (frame.kind === 'response') return { kind: 'response', payload: frame.response };
  return { kind: frame.tag || 'unknown', payload: frame.raw };
}

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
      /* upstream unused */
    },
  };
  return { port, bridge };
}

/** Pump every fixture line through the real decoder + transport, advancing
 * the fake clock so coalesced batches actually flush (finding #2 in
 * docs/transcript-rendering.md §9: a UI that never flushes streams nothing). */
function replayFixture(transport: Transport): void {
  const decoder = new FrameDecoder();
  const lines = FIXTURE.split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    const frame = decoder.feedLine(line);
    if (frame !== null) transport.ingest(toOutbound(frame));
    // Flush every 4th line — same frame clock the parity golden uses.
    if (i % 4 === 3) vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
  });
  vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
}

describe('fixture replay through the real pipeline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('maps the capture to the expected rows', () => {
    const { port, bridge } = fakeWiring();
    const transport = new Transport();
    transport.attach(port);
    const store = new TranscriptStore();
    bridge.subscribe(store.apply);

    replayFixture(transport);
    // Drain any rAF-scheduled coalescer flush.
    act(() => vi.runOnlyPendingTimers());

    const rows = store.model.messages;
    // The capture holds a `custom`-role notice (string content → empty text),
    // one user prompt, and one assistant reply — same 3 rows the Rust golden
    // settles to.
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ row: 'text', role: 'custom' });
    expect(rows[1]).toMatchObject({ row: 'text', role: 'user' });
    expect(rows[1]?.row === 'text' && rows[1].text).toContain('Rust ownership');
    expect(rows[2]).toMatchObject({ row: 'text', role: 'assistant', streaming: false });
    // Final text equals the LAST snapshot, not the sum of deltas (§9 finding 1).
    const assistant = rows[2];
    if (assistant?.row !== 'text') throw new Error('expected text row');
    expect(assistant.text).toContain('`');
    expect(store.model.streaming).toBe(false);
    // Seq continuity end to end.
    expect(store.getState().gapDetected).toBe(false);
    expect(store.getState().lastSeq).toBe(store.getState().batchesDelivered);
  });

  it('streams intermediate text before agent_end (frames actually flush)', () => {
    const { port, bridge } = fakeWiring();
    const transport = new Transport();
    transport.attach(port);
    const store = new TranscriptStore();
    bridge.subscribe(store.apply);

    const decoder = new FrameDecoder();
    const lines = FIXTURE.split('\n').filter((l) => l.trim().length > 0);
    const textLens: number[] = [];
    lines.forEach((line, i) => {
      const frame = decoder.feedLine(line);
      if (frame !== null) transport.ingest(toOutbound(frame));
      if (i % 4 === 3) {
        vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
        act(() => vi.runOnlyPendingTimers()); // rAF coalescer flush
        const tail = store.model.messages[store.model.messages.length - 1];
        if (tail?.row === 'text' && tail.role === 'assistant' && tail.streaming) {
          textLens.push(tail.text.length);
        }
      }
    });
    // The tail visibly grew during the replay — streaming was not a single
    // settle-at-end paint.
    expect(textLens.length).toBeGreaterThan(3);
    expect(textLens[textLens.length - 1]).toBeGreaterThan(textLens[0] ?? 0);
  });

  it('renders the replayed transcript in the pane', () => {
    const { port, bridge } = fakeWiring();
    const transport = new Transport();
    transport.attach(port);

    // jsdom hardcodes offsetWidth/offsetHeight to 0, which collapses the
    // virtualizer's viewport to nothing. Give every element a real size.
    const proto = HTMLElement.prototype;
    vi.spyOn(proto, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(proto, 'offsetWidth', 'get').mockReturnValue(800);

    render(
      <OmpProvider bridge={bridge}>
        <TranscriptPane />
      </OmpProvider>,
    );

    act(() => {
      replayFixture(transport);
      vi.runOnlyPendingTimers();
    });

    expect(screen.getByText(/Rust ownership/)).toBeTruthy();
  });
});