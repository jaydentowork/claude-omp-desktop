//! `omp` child-process pump.
//!
//! Spawns `omp --mode rpc-ui --cwd <cwd>`, feeds stdout through `FrameDecoder`,
//! and forwards each decoded frame into a `Transport`. On unexpected child
//! exit the pump synthesizes a `notice` + terminal `agent_end` so the renderer
//! stops spinning (RPC gap #3 in docs/rpc-events.md §4.4 — omp emits no
//! process-exit event; mirrors ompweb `lib/rpc-manager.ts:335-347`).
//!
//! Teardown uses `taskkill /pid <pid> /t /f`: omp spawns LSP / extension
//! grandchildren that `child.kill()` would orphan (locked constraint 4).
//!
//! Headless-test friendly: `spawn` and `killTree` are injectable seams, so
//! the crash test runs without `omp` on PATH or Windows-only tools.

import {
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { FrameDecoder, CHILD_EXIT_NOTICE, type Frame } from './omp-rpc';
import type { Transport, OutboundFrame } from './transport';

/** Tail of stderr retained for the synthesized error notice. */
const STDERR_TAIL_BYTES = 2048;

export interface OmpPumpOptions {
  /** Path to the `omp` executable. */
  ompPath: string;
  /** Working directory passed as `--cwd` (and used as spawn cwd). */
  cwd: string;
  /** Transport receiving decoded frames + synthesized lifecycle frames. */
  transport: Transport;
  /** Injectable for tests; defaults to `node:child_process.spawn`. */
  spawn?: typeof nodeSpawn;
  /** Injectable for tests; defaults to `taskkill /pid <pid> /t /f`. */
  killTree?: (pid: number) => void;
}

/**
 * Owns one `omp` child for its lifetime. `dispose()` is idempotent and tears
 * down the whole process tree; the exit handler then synthesizes nothing
 * because teardown is deliberate.
 */
export class OmpPump {
  private readonly transport: Transport;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly killTree: (pid: number) => void;
  private readonly ompPath: string;
  private readonly cwd: string;

  private child: ChildProcess | null = null;
  private decoder = new FrameDecoder();
  /** Partial NDJSON line carried across stdout 'data' events. */
  private stdoutBuf = '';
  private stderrTail = '';
  private exited = false;
  private disposed = false;
  /** Tracks agent_start/agent_end so a crash mid-run emits a terminal agent_end. */
  private streaming = false;

  constructor(opts: OmpPumpOptions) {
    this.transport = opts.transport;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.killTree = opts.killTree ?? taskkillTree;
    this.ompPath = opts.ompPath;
    this.cwd = opts.cwd;
  }

  /** PID of the live child, or null before start / after exit. */
  get pid(): number | null {
    return this.exited ? null : this.child?.pid ?? null;
  }

  start(): void {
    if (this.child) throw new Error('OmpPump already started');
    this.child = this.spawnFn(this.ompPath, ['--mode', 'rpc-ui', '--cwd', this.cwd], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.on('exit', (code) => this.onExit(code));
    // 'exit' never fires when spawn itself fails (e.g. ENOENT) — route
    // 'error' through the same crash path so the UI still gets its notice.
    this.child.on('error', (err) => {
      this.stderrTail = err.message;
      this.onExit(null);
    });
  }

  /** Write one command line to the child's stdin (caller appends no newline). */
  send(line: string): void {
    this.child?.stdin?.write(line + '\n');
  }

  /**
   * Deliberate teardown: taskkill the whole tree. The subsequent 'exit'
   * event synthesizes nothing because `disposed` is set first.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pid = this.child?.pid;
    if (pid !== undefined && !this.exited) {
      try {
        this.killTree(pid);
      } catch {
        // best-effort — child may already be gone
      }
    }
  }

  private onStdout(chunk: string): void {
    const data = this.stdoutBuf + chunk;
    const lines = data.split('\n');
    this.stdoutBuf = lines.pop() ?? ''; // last element is the unterminated tail
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') continue;
      let frame: Frame | null;
      try {
        frame = this.decoder.feedLine(line);
      } catch (err) {
        // Parse errors never kill the RPC loop (docs/rpc-events.md §5.3);
        // surface them as a notice and keep reading.
        this.transport.ingest({
          kind: 'notice',
          payload: { level: 'error', message: `frame decode failed: ${(err as Error).message}` },
        });
        continue;
      }
      if (frame === null) continue; // chunk sequence still assembling
      this.trackStreaming(frame);
      this.transport.ingest(toOutbound(frame));
    }
  }

  private trackStreaming(frame: Frame): void {
    if (frame.kind !== 'unknown') return;
    if (frame.tag === 'agent_start') this.streaming = true;
    // Only a terminal agent_end clears streaming (docs/rpc-events.md §1.1:
    // isTerminal !== false, absent ⇒ terminal).
    if (frame.tag === 'agent_end') {
      const raw = frame.raw as { isTerminal?: boolean };
      if (raw.isTerminal !== false) this.streaming = false;
    }
  }

  private onExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    const wasStreaming = this.streaming;
    this.streaming = false;
    // Deliberate teardown or clean exit (stdin close exits 0, §5.3) — no crash.
    if (this.disposed || code === 0) return;
    const detail = this.stderrTail.trim().split('\n').pop() ?? '';
    this.transport.ingest({
      kind: 'notice',
      payload: {
        level: 'error',
        message: `${CHILD_EXIT_NOTICE}${detail ? `: ${detail}` : '.'}`,
      },
    });
    if (wasStreaming) {
      this.transport.ingest({
        kind: 'agent_end',
        payload: { isTerminal: true, messages: [] },
      });
    }
  }
}

/** Windows tree kill. `spawnSync` because teardown runs during window close. */
export function taskkillTree(pid: number): void {
  spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
}

function toOutbound(frame: Frame): OutboundFrame {
  if (frame.kind === 'ready') return { kind: 'ready', payload: frame.ready };
  if (frame.kind === 'response') return { kind: 'response', payload: frame.response };
  return { kind: frame.tag || 'unknown', payload: frame.raw };
}
