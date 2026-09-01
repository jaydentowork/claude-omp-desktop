// Model/thinking switcher state (docs/model-thinking-switcher.md §1–§3).
//
// The two paths are deliberately asymmetric (spec §1, the load-bearing fact):
// - Model: optimistic paint on commit, revert on failure, reconcile on
//   `config_update`; `model_changed` carries no payload so it forces a
//   `get_state` round-trip.
// - Thinking: event-driven only. The label follows `thinking_level_changed`,
//   never the click.

import { CHILD_EXIT_NOTICE } from '../main/omp-rpc';
import type { StreamFrame, TranscriptStore } from './omp-provider';
import type { RpcClient } from './rpc-client';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The catalog fields the picker renders (`Model.name` is always present —
 * spec §2.3; provider/id key the `set_model` command). */
export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
}

export interface SwitcherState {
  /** Display name on the status-bar label. Never empty once state has loaded. */
  readonly modelLabel: string;
  /** Capitalized in the view; stored as the raw level. */
  readonly thinkingLevel: ThinkingLevel | null;
  /** Inline cluster notice (spec §2.4); null when quiet. */
  readonly notice: string | null;
  /** False once the child died — labels dim, clicks no-op (spec §2.4). */
  readonly alive: boolean;
  readonly catalog: readonly CatalogModel[];
}

const NOTICE_MS = 6000;

function levelOf(v: unknown): ThinkingLevel | null {
  return typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v)
    ? (v as ThinkingLevel)
    : null;
}

function modelName(m: unknown): string | null {
  const name = (m as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

export class SwitcherStore {
  private state: SwitcherState = {
    modelLabel: '',
    thinkingLevel: null,
    notice: null,
    alive: true,
    catalog: [],
  };
  private listeners = new Set<() => void>();
  /** Label to revert to if the in-flight `set_model` fails (spec §2.3). */
  private pendingModelRevert: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private rpc: RpcClient | null = null;

  attach(store: TranscriptStore, rpc: RpcClient): () => void {
    this.rpc = rpc;
    const offFrame = store.onFrame(this.onFrame);
    const offReady = rpc.onReady(() => {
      void this.refreshState();
      void this.refreshCatalog();
    });
    return () => {
      offFrame();
      offReady();
      if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    };
  }

  getState = (): SwitcherState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private set(patch: Partial<SwitcherState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private showNotice(text: string): void {
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.set({ notice: text });
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.set({ notice: null });
    }, NOTICE_MS);
  }

  /** Re-read authoritative state; the reconciliation anchor (rpc-events §4.2). */
  async refreshState(): Promise<void> {
    if (this.rpc === null) return;
    try {
      const r = await this.rpc.request({ type: 'get_state' });
      if (!r.success) return;
      const data = r.data as { model?: unknown; thinkingLevel?: unknown } | undefined;
      const name = modelName(data?.model);
      // A get_state reply is authoritative: it clears any optimistic paint.
      this.pendingModelRevert = null;
      this.set({
        modelLabel: name ?? this.state.modelLabel,
        thinkingLevel: levelOf(data?.thinkingLevel) ?? this.state.thinkingLevel,
      });
    } catch {
      // dead or old child; labels keep their last value
    }
  }

  /** Fetch the catalog. Called on ready and each time the picker opens
   * (spec §2.2 — `omp login` in a terminal can grow it mid-session).
   * Returns false on failure so the picker stays closed. */
  async refreshCatalog(): Promise<boolean> {
    if (this.rpc === null) return false;
    try {
      const r = await this.rpc.request({ type: 'get_available_models' });
      if (!r.success) throw new Error(r.error);
      const data = r.data as { models?: unknown[] } | undefined;
      const catalog: CatalogModel[] = [];
      for (const m of data?.models ?? []) {
        const model = m as { id?: unknown; name?: unknown; provider?: unknown };
        if (typeof model.id === 'string' && typeof model.provider === 'string') {
          catalog.push({
            id: model.id,
            name: modelName(model) ?? model.id,
            provider: model.provider,
          });
        }
      }
      this.set({ catalog });
      return true;
    } catch {
      this.showNotice('Models unavailable · click to retry');
      return false;
    }
  }

  /** Commit a model pick: optimistic paint, then reconcile (spec §2.3). */
  async setModel(model: CatalogModel): Promise<void> {
    if (this.rpc === null || !this.state.alive) return;
    // Keep the first revert target if commits overlap — it is the last
    // server-confirmed label.
    if (this.pendingModelRevert === null) this.pendingModelRevert = this.state.modelLabel;
    this.set({ modelLabel: model.name });
    try {
      const r = await this.rpc.request({ type: 'set_model', provider: model.provider, modelId: model.id });
      if (r.success) {
        this.pendingModelRevert = null;
        return;
      }
      this.revertModel(r.error ?? 'set_model failed');
    } catch (e) {
      this.revertModel((e as Error).message);
    }
  }

  private revertModel(error: string): void {
    if (this.pendingModelRevert !== null) {
      this.set({ modelLabel: this.pendingModelRevert });
      this.pendingModelRevert = null;
    }
    this.showNotice(error);
  }

  /** Commit a thinking level. No optimistic paint — the label follows
   * `thinking_level_changed` (spec §3.2). Resolves true when the level was
   * accepted so the picker can close. */
  async setThinkingLevel(level: ThinkingLevel): Promise<boolean> {
    if (this.rpc === null || !this.state.alive) return false;
    try {
      const r = await this.rpc.request({ type: 'set_thinking_level', level });
      if (!r.success) {
        this.showNotice(r.error ?? 'set_thinking_level failed');
        return false;
      }
      return true;
    } catch (e) {
      this.showNotice((e as Error).message);
      return false;
    }
  }

  private onFrame = (frame: StreamFrame): void => {
    switch (frame.kind) {
      case 'config_update': {
        // The event wins over any optimistic paint (spec §2.3 step 5).
        const p = frame.payload as { model?: unknown; thinkingLevel?: unknown };
        const name = modelName(p.model);
        this.pendingModelRevert = null;
        this.set({
          modelLabel: name ?? this.state.modelLabel,
          thinkingLevel: levelOf(p.thinkingLevel) ?? this.state.thinkingLevel,
        });
        break;
      }
      case 'model_changed':
        // Signal only — no payload; truth needs a get_state round-trip.
        void this.refreshState();
        break;
      case 'thinking_level_changed': {
        // Label rule: resolved > configured > thinkingLevel (spec §3.2).
        const p = frame.payload as { thinkingLevel?: unknown; configured?: unknown; resolved?: unknown };
        const level = levelOf(p.resolved) ?? levelOf(p.configured) ?? levelOf(p.thinkingLevel);
        if (level !== null) this.set({ thinkingLevel: level });
        break;
      }
      case 'notice': {
        // The pump's synthesized child-death notice dims the whole cluster
        // (spec §2.4: RPC child dead → labels dim, clicks no-op).
        const p = frame.payload as { message?: unknown };
        if (typeof p.message === 'string' && p.message.startsWith(CHILD_EXIT_NOTICE)) {
          this.set({ alive: false });
        }
        break;
      }
    }
  };
}

/** `high` → `High` for the label and the popover title. */
export function displayLevel(level: ThinkingLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}
