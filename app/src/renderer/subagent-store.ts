// Subagent panel store (docs/subagent-panel.md §6–§7). Owns the PanelRow
// map and its group ordering. Update strategy is per-card: a
// `subagent_progress` frame notifies only the matching row's subscribers;
// panel-level subscribers hear only membership changes (a card entering,
// leaving, or moving between Running and Finished).
//
// `get_subagents` DELETES finished entries server-side (rpc-events.md §3.3),
// so terminal rows are retained here, in memory only — restart starts empty.

import type { StreamFrame, TranscriptStore } from './omp-provider';
import type { RpcClient } from './rpc-client';

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';

/** The `AgentProgress` fields the cards render (rpc-events.md §3.2). */
export interface AgentProgress {
  id: string;
  status: SubagentStatus;
  task: string;
  toolCount: number;
  tokens: number;
  cost: number;
  durationMs: number;
  currentTool?: string;
  contextTokens?: number;
}

export interface PanelRow {
  id: string;
  agentName: string;
  task: string;
  description?: string;
  status: SubagentStatus;
  lastProgress?: AgentProgress;
  /** Local receipt time of `lastProgress`, so elapsed keeps ticking between
   * progress frames: elapsed = durationMs + (now - progressAtMs). */
  progressAtMs?: number;
  startedMs: number;
  terminalMs?: number;
  sessionFile?: string;
  /** Bumped on any change to this row; cards memo on it. */
  rev: number;
}

/** Panel-level snapshot: group membership only (spec §6). */
export interface PanelGroups {
  running: readonly string[];
  finished: readonly string[];
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted']);

/** Lifecycle `"started"` maps to progress `"running"` (rpc-events.md §3.3). */
function normalizeStatus(s: string): SubagentStatus {
  if (s === 'started') return 'running';
  if (s === 'pending' || s === 'running' || s === 'completed' || s === 'failed' || s === 'aborted') return s;
  return 'running';
}

export class SubagentStore {
  private readonly rows = new Map<string, PanelRow>();
  private groups: PanelGroups = { running: [], finished: [] };
  private readonly panelListeners = new Set<() => void>();
  private readonly rowListeners = new Map<string, Set<() => void>>();
  /** Single 1 Hz elapsed ticker; mounted only while a running row exists. */
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** False until `set_subagent_subscription` succeeds; older builds degrade
   * to "no subagent info" (spec §1). */
  private supported = true;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Wire into the frame stream + startup sequence. */
  attach(store: TranscriptStore, rpc: RpcClient): () => void {
    const offFrame = store.onFrame(this.onFrame);
    const offReady = rpc.onReady(() => void this.onSessionReady(rpc));
    return () => {
      offFrame();
      offReady();
      this.stopTicker();
    };
  }

  private async onSessionReady(rpc: RpcClient): Promise<void> {
    // Spawn-order step 3 (rpc-events.md §0): wrapped in a catch — a build
    // without the command must not fail startup.
    try {
      await rpc.request({ type: 'set_subagent_subscription', level: 'progress' });
    } catch {
      this.supported = false;
      this.notifyPanel();
      return;
    }
    // Seed the panel before the first live frame (spec §1). The snapshot
    // never contains finished agents; in-memory terminal rows survive.
    try {
      const r = await rpc.request({ type: 'get_subagents' });
      if (r.success) {
        const data = r.data as { subagents?: unknown[] } | undefined;
        for (const s of data?.subagents ?? []) this.applySnapshot(s);
      }
    } catch {
      // roster arrives via live frames instead
    }
  }

  get isSupported(): boolean {
    return this.supported;
  }

  getGroups = (): PanelGroups => this.groups;

  getRow(id: string): PanelRow | undefined {
    return this.rows.get(id);
  }

  /** Elapsed ms for a running card: server durationMs plus local time since
   * the frame carrying it (spec §6 — durationMs is server-side, the display
   * ticks between frames). */
  elapsedMs(row: PanelRow): number {
    if (row.lastProgress !== undefined && row.progressAtMs !== undefined) {
      return row.lastProgress.durationMs + (this.now() - row.progressAtMs);
    }
    return this.now() - row.startedMs;
  }

  /** Panel-level subscription: membership changes only. */
  subscribe = (cb: () => void): (() => void) => {
    this.panelListeners.add(cb);
    return () => this.panelListeners.delete(cb);
  };

  /** Per-card subscription (spec §6: per-card, not per-panel). */
  subscribeRow(id: string, cb: () => void): () => void {
    let set = this.rowListeners.get(id);
    if (set === undefined) {
      set = new Set();
      this.rowListeners.set(id, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.rowListeners.delete(id);
    };
  }

  /** `Clear` removes finished rows from the in-memory model (spec §3);
   * there is no server call to make. */
  clearFinished(): void {
    let changed = false;
    for (const [id, row] of this.rows) {
      if (TERMINAL.has(row.status)) {
        this.rows.delete(id);
        changed = true;
      }
    }
    if (changed) this.rebuildGroups();
  }

  private onFrame = (frame: StreamFrame): void => {
    if (frame.kind === 'subagent_lifecycle') {
      const p = (frame.payload as { payload?: unknown })?.payload;
      if (p !== undefined) this.applyLifecycle(p);
    } else if (frame.kind === 'subagent_progress') {
      const p = (frame.payload as { payload?: unknown })?.payload;
      if (p !== undefined) this.applyProgress(p);
    }
  };

  private applyLifecycle(payload: unknown): void {
    const p = payload as {
      id?: string;
      agent?: string;
      description?: string;
      status?: string;
      sessionFile?: string;
    };
    if (typeof p.id !== 'string') return;
    const status = normalizeStatus(p.status ?? 'started');
    const existing = this.rows.get(p.id);
    if (existing === undefined) {
      this.rows.set(p.id, {
        id: p.id,
        agentName: p.agent ?? 'agent',
        task: p.description ?? '',
        description: p.description,
        status,
        startedMs: this.now(),
        terminalMs: TERMINAL.has(status) ? this.now() : undefined,
        sessionFile: p.sessionFile,
        rev: 0,
      });
      this.rebuildGroups();
      return;
    }
    const wasTerminal = TERMINAL.has(existing.status);
    existing.status = status;
    existing.sessionFile = p.sessionFile ?? existing.sessionFile;
    if (p.description !== undefined) existing.description = p.description;
    existing.rev += 1;
    if (!wasTerminal && TERMINAL.has(status)) {
      // Row moves Running → Finished in place; ordering keys on the arrival
      // time of the terminal frame (spec §3).
      existing.terminalMs = this.now();
      this.rebuildGroups();
    } else {
      this.notifyRow(p.id);
    }
  }

  private applyProgress(payload: unknown): void {
    const p = payload as { agent?: string; task?: string; sessionFile?: string; progress?: AgentProgress };
    const progress = p.progress;
    if (progress === undefined || typeof progress.id !== 'string') return;
    const existing = this.rows.get(progress.id);
    if (existing === undefined) {
      // Progress before any lifecycle frame — defensive (spec §3).
      this.rows.set(progress.id, {
        id: progress.id,
        agentName: p.agent ?? 'agent',
        task: p.task ?? '',
        status: normalizeStatus(progress.status),
        lastProgress: progress,
        progressAtMs: this.now(),
        startedMs: this.now(),
        sessionFile: p.sessionFile,
        rev: 0,
      });
      this.rebuildGroups();
      return;
    }
    const oldStatus = existing.status;
    existing.lastProgress = progress;
    existing.progressAtMs = this.now();
    if (p.task !== undefined) existing.task = p.task;
    existing.sessionFile = p.sessionFile ?? existing.sessionFile;
    // Progress status also moves pending → running (group-internal, no
    // membership change) but never overrides a terminal lifecycle status.
    if (!TERMINAL.has(oldStatus)) existing.status = normalizeStatus(progress.status);
    existing.rev += 1;
    if (!TERMINAL.has(oldStatus) && TERMINAL.has(existing.status)) {
      existing.terminalMs = this.now();
      this.rebuildGroups();
    } else {
      this.notifyRow(existing.id);
    }
  }

  private applySnapshot(snapshot: unknown): void {
    const s = snapshot as {
      id?: string;
      agent?: string;
      description?: string;
      status?: string;
      task?: string;
      sessionFile?: string;
      progress?: AgentProgress;
    };
    if (typeof s.id !== 'string' || this.rows.has(s.id)) return;
    this.rows.set(s.id, {
      id: s.id,
      agentName: s.agent ?? 'agent',
      task: s.task ?? s.description ?? '',
      description: s.description,
      status: normalizeStatus(s.status ?? 'started'),
      lastProgress: s.progress,
      progressAtMs: s.progress !== undefined ? this.now() : undefined,
      startedMs: this.now(),
      sessionFile: s.sessionFile,
      rev: 0,
    });
    this.rebuildGroups();
  }

  /** Rebuild group ordering on membership change. Newest first, keyed by
   * group-entry time (spec §3). Small arrays; sort cost is noise. */
  private rebuildGroups(): void {
    const running: PanelRow[] = [];
    const finished: PanelRow[] = [];
    for (const row of this.rows.values()) {
      (TERMINAL.has(row.status) ? finished : running).push(row);
    }
    running.sort((a, b) => b.startedMs - a.startedMs);
    finished.sort((a, b) => (b.terminalMs ?? 0) - (a.terminalMs ?? 0));
    this.groups = {
      running: running.map((r) => r.id),
      finished: finished.map((r) => r.id),
    };
    this.syncTicker();
    this.notifyPanel();
    // Membership shifts also change per-card state (status text moved from
    // elapsed to Completed etc.) — nudge every card once.
    for (const id of this.rowListeners.keys()) this.notifyRow(id);
  }

  private notifyPanel(): void {
    for (const l of this.panelListeners) l();
  }

  private notifyRow(id: string): void {
    const set = this.rowListeners.get(id);
    if (set !== undefined) for (const l of set) l();
  }

  /** One store-level 1 Hz interval, mounted only while a card is running
   * (spec §6 option b). Bumps each running row so its card re-renders the
   * elapsed string. */
  private syncTicker(): void {
    const anyRunning = this.groups.running.length > 0;
    if (anyRunning && this.ticker === null) {
      this.ticker = setInterval(() => {
        for (const id of this.groups.running) {
          const row = this.rows.get(id);
          if (row !== undefined) {
            row.rev += 1;
            this.notifyRow(id);
          }
        }
      }, 1000);
    } else if (!anyRunning) {
      this.stopTicker();
    }
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}

// --- display formatting (rpc-events.md §3.3 formatting reference) ----------

/** `67.1k tokens` — k suffix, 1 dp until the value needs three digits
 * (matches the screenshot reference strings in rpc-events.md §3.3). */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  return k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** `55s` under a minute, `Nm` above, empty under 1 s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}
