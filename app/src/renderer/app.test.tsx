// Window-shell acceptance (issue #22): the three-pane frame renders around
// the transcript, both side panels collapse/expand from their affordances,
// and the recorded capture still replays through the framed pane. The 360 px
// transcript floor is a CSS `minmax` on `.pane-grid` — jsdom does no layout,
// so it is asserted by fixture replay + the grid living in index.css, not by
// pixel measurement.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePortMain } from 'electron';
import { FLUSH_INTERVAL_MS, Transport } from '../main/transport';
import { FrameDecoder, type Frame } from '../main/omp-rpc';
import { OmpProvider, type OmpBridge } from './omp-provider';
import { App } from './app';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = readFileSync(
  join(__dirname, '../../../assets/fixtures/streaming-capture.ndjson'),
  'utf8',
);

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

function replayFixture(transport: Transport): void {
  const decoder = new FrameDecoder();
  const lines = FIXTURE.split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    const frame = decoder.feedLine(line);
    if (frame !== null) transport.ingest(toOutbound(frame));
    if (i % 4 === 3) vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
  });
  vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
}

function renderShell() {
  const { port, bridge } = fakeWiring();
  const transport = new Transport();
  transport.attach(port);
  const utils = render(
    <OmpProvider bridge={bridge}>
      <App />
    </OmpProvider>,
  );
  return { transport, ...utils };
}

describe('window shell', () => {
  // vitest runs without injected globals, so RTL's auto-cleanup never
  // registers — unmount explicitly or renders pile up in document.body.
  afterEach(() => cleanup());

  it('frames titlebar, three panes and status bar', () => {
    const { container } = renderShell();
    expect(container.querySelector('.titlebar')).not.toBeNull();
    expect(container.querySelector('.sidebar')).not.toBeNull();
    expect(container.querySelector('.transcript-pane')).not.toBeNull();
    expect(container.querySelector('.tasks-panel')).not.toBeNull();
    expect(container.querySelector('.statusbar')).not.toBeNull();
    expect(container.querySelector('.pane-grid')?.getAttribute('data-sidebar')).toBe('open');
    expect(container.querySelector('.pane-grid')?.getAttribute('data-tasks')).toBe('open');
  });

  it('sidebar collapses and re-expands from the titlebar toggle', () => {
    const { container, getByLabelText } = renderShell();
    fireEvent.click(getByLabelText('Hide sidebar'));
    expect(container.querySelector('.sidebar')).toBeNull();
    expect(container.querySelector('.pane-grid')?.getAttribute('data-sidebar')).toBe(
      'collapsed',
    );
    fireEvent.click(getByLabelText('Show sidebar'));
    expect(container.querySelector('.sidebar')).not.toBeNull();
  });

  it('tasks panel collapses from its header and re-expands', () => {
    const { container, getByLabelText } = renderShell();
    fireEvent.click(getByLabelText('Hide tasks panel'));
    expect(container.querySelector('.tasks-panel')).toBeNull();
    expect(container.querySelector('.pane-grid')?.getAttribute('data-tasks')).toBe(
      'collapsed',
    );
    fireEvent.click(getByLabelText('Show tasks panel'));
    expect(container.querySelector('.tasks-panel')).not.toBeNull();
  });

  describe('fixture replay inside the frame', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('renders the capture with both panels open', () => {
      // jsdom collapses offsetWidth/offsetHeight to 0; give the virtualizer
      // a viewport.
      const proto = HTMLElement.prototype;
      vi.spyOn(proto, 'offsetHeight', 'get').mockReturnValue(600);
      vi.spyOn(proto, 'offsetWidth', 'get').mockReturnValue(800);

      const { transport, getByText } = renderShell();
      act(() => {
        replayFixture(transport);
        vi.runOnlyPendingTimers();
      });
      expect(getByText(/Rust ownership/)).toBeTruthy();
    });
  });
});
