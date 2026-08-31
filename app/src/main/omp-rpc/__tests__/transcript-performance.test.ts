import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptModel, type ChatMessage } from '../transcript';

const FLUSHES = 200;
const FRAME_BUDGET_MS = 1000 / 60;

function modelWithBacklog(rows: number): TranscriptModel {
  const model = new TranscriptModel();
  model.messages = Array.from({ length: rows }, (_, i): ChatMessage => ({
    row: 'text',
    id: `backlog-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: 'settled text',
    streaming: false,
  }));
  model.apply({ event: 'message_start', id: 'live', role: 'assistant' });
  return model;
}

function flushTimings(rows: number): number[] {
  const model = modelWithBacklog(rows);
  const timings: number[] = [];
  let text = '';

  for (let i = 0; i < FLUSHES; i++) {
    text += 'token ';
    const event = { event: 'message_update' as const, id: 'live', text };
    const started = performance.now();
    model.apply(event);
    timings.push(performance.now() - started);
  }
  return timings;
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

describe('streaming transcript cost', () => {
  it('stays flat from 100 to 50,000 settled rows', () => {
    const small = Math.max(median(flushTimings(100)), 0.001);
    const large = Math.max(median(flushTimings(50_000)), 0.001);

    expect(large / small).toBeLessThan(10);
  });

  it('leaves most of the frame budget free at 50,000 rows', () => {
    expect(Math.max(...flushTimings(50_000))).toBeLessThan(FRAME_BUDGET_MS / 10);
  });

  it('uses the cached streaming row instead of scanning the backlog', () => {
    const model = modelWithBacklog(5_000);
    const findIndex = vi.spyOn(model.messages, 'findIndex');

    for (let i = 0; i < 500; i++) {
      model.apply({ event: 'message_update', id: 'live', text: `token ${i}` });
    }

    expect(findIndex).not.toHaveBeenCalled();
    expect(model.streamingIndex()).toBe(5_000);
  });
});
