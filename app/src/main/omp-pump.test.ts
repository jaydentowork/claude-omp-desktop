// Crash test from issue #12: spawn a child that emits 100 frames, have it
// die mid-stream, and assert the pump synthesizes exactly one error notice +
// one terminal agent_end, and that the (faked) taskkill tree teardown runs
// on dispose. Uses a real Node child process so the stdout/stderr/exit
// plumbing is exercised for real — only `omp` itself is faked.

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { OmpPump } from './omp-pump';
import { Transport, type OutboundFrame } from './transport';
import type { MessagePortMain } from 'electron';

/** Collect every frame the transport flushes. */
function collectingTransport(): { transport: Transport; frames: OutboundFrame[] } {
  const frames: OutboundFrame[] = [];
  const transport = new Transport();
  transport.attach({
    postMessage: (data: { frames: OutboundFrame[] }) => frames.push(...data.frames),
    on: () => undefined,
    close: () => undefined,
  } as unknown as MessagePortMain);
  return { transport, frames };
}

/**
 * In-process fake child: scriptable stdout/stderr/exit with the same event
 * surface OmpPump touches. Plain EventEmitters (not real streams) so 'data'
 * delivery is synchronous and the test is deterministic.
 */
class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
  write(chunk: string): boolean {
    this.emit('data', chunk);
    return true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = new FakeStream();
  readonly pid = 4242;
}

function fakeSpawnPump(overrides?: { killTree?: (pid: number) => void }) {
  const child = new FakeChild();
  const { transport, frames } = collectingTransport();
  const killed: number[] = [];
  const pump = new OmpPump({
    ompPath: 'omp',
    cwd: 'C:\\fake',
    transport,
    spawn: (() => child as unknown as ChildProcess) as unknown as typeof nodeSpawn,
    killTree: overrides?.killTree ?? ((pid) => killed.push(pid)),
  });
  pump.start();
  return { pump, child, transport, frames, killed };
}

const line = (obj: unknown) => JSON.stringify(obj) + '\n';

/** Drain the transport's 16ms coalesce timer so `frames` is complete. */
const settle = (t: Transport) => t.dispose();

describe('OmpPump crash synthesis (locked constraint 5)', () => {
  it('emits 100 streamed frames, then exactly one error notice + one terminal agent_end on mid-stream death', () => {
    const { child, transport, frames } = fakeSpawnPump();

    child.stdout.write(line({ type: 'ready', protocolVersion: 1 }));
    child.stdout.write(line({ type: 'agent_start' }));
    for (let i = 0; i < 100; i++) {
      child.stdout.write(line({ type: 'message_update', message: { i } }));
    }
    // Killed mid-stream: non-zero exit, stderr tail explains why.
    child.stderr.write('boom: omp fell over\n');
    child.emit('exit', 1, null);
    settle(transport);

    expect(frames.filter((f) => f.kind === 'message_update')).toHaveLength(100);

    const notices = frames.filter((f) => f.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].payload).toEqual({
      level: 'error',
      message: 'The omp process for this session exited unexpectedly: boom: omp fell over',
    });

    const ends = frames.filter((f) => f.kind === 'agent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].payload).toEqual({ isTerminal: true, messages: [] });

    // Synthesized frames come after every streamed frame.
    expect(frames.indexOf(notices[0])).toBeGreaterThan(
      frames.findIndex((f) => f.kind === 'message_update'),
    );
  });

  it('does not synthesize agent_end when no agent run was in flight', () => {
    const { child, transport, frames } = fakeSpawnPump();
    child.stdout.write(line({ type: 'ready', protocolVersion: 1 }));
    child.emit('exit', 1, null);
    settle(transport);

    expect(frames.filter((f) => f.kind === 'notice')).toHaveLength(1);
    expect(frames.filter((f) => f.kind === 'agent_end')).toHaveLength(0);
  });

  it('a terminal agent_end from omp clears streaming, so a later crash adds no second one', () => {
    const { child, transport, frames } = fakeSpawnPump();
    child.stdout.write(line({ type: 'agent_start' }));
    child.stdout.write(line({ type: 'agent_end', messages: [] })); // isTerminal absent ⇒ terminal
    child.emit('exit', 1, null);
    settle(transport);

    // Only omp's own agent_end — no synthesized duplicate.
    expect(frames.filter((f) => f.kind === 'agent_end')).toHaveLength(1);
  });

  it('a non-terminal agent_end keeps streaming, so a crash still synthesizes the terminal one', () => {
    const { child, transport, frames } = fakeSpawnPump();
    child.stdout.write(line({ type: 'agent_start' }));
    child.stdout.write(line({ type: 'agent_end', isTerminal: false, messages: [] }));
    child.emit('exit', 1, null);
    settle(transport);

    const ends = frames.filter((f) => f.kind === 'agent_end');
    expect(ends).toHaveLength(2);
    expect(ends[1].payload).toEqual({ isTerminal: true, messages: [] });
  });

  it('clean exit (code 0) synthesizes nothing', () => {
    const { child, transport, frames } = fakeSpawnPump();
    child.stdout.write(line({ type: 'ready', protocolVersion: 1 }));
    child.emit('exit', 0, null);
    settle(transport);

    expect(frames.filter((f) => f.kind === 'notice')).toHaveLength(0);
    expect(frames.filter((f) => f.kind === 'agent_end')).toHaveLength(0);
  });

  it('reassembles NDJSON lines split across data events', () => {
    const { child, transport, frames } = fakeSpawnPump();
    const whole = line({ type: 'message_update', message: { split: true } });
    child.stdout.write(whole.slice(0, 10));
    child.stdout.write(whole.slice(10));
    settle(transport);

    expect(frames.filter((f) => f.kind === 'message_update')).toHaveLength(1);
  });
});

describe('OmpPump teardown (locked constraint 4)', () => {
  it('dispose runs killTree on the child pid', () => {
    const { pump, killed } = fakeSpawnPump();
    pump.dispose();
    expect(killed).toEqual([4242]);
  });

  it('dispose is idempotent and the ensuing exit synthesizes nothing', () => {
    const { pump, child, transport, frames, killed } = fakeSpawnPump();
    child.stdout.write(line({ type: 'agent_start' }));
    pump.dispose();
    pump.dispose();
    child.emit('exit', 1, null); // taskkill makes the child exit non-zero
    settle(transport);

    expect(killed).toEqual([4242]);
    expect(frames.filter((f) => f.kind === 'notice')).toHaveLength(0);
    expect(frames.filter((f) => f.kind === 'agent_end')).toHaveLength(0);
  });

  it('dispose after natural exit does not killTree a dead pid', () => {
    const { pump, child, killed } = fakeSpawnPump();
    child.emit('exit', 0, null);
    pump.dispose();
    expect(killed).toEqual([]);
    expect(pump.pid).toBeNull();
  });

  it('spawn failure (error event, no exit) still produces the crash notice', () => {
    const { child, transport, frames } = fakeSpawnPump();
    child.emit('error', new Error('spawn omp ENOENT'));
    settle(transport);

    const notices = frames.filter((f) => f.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect((notices[0].payload as { message: string }).message).toContain('spawn omp ENOENT');
  });
});
