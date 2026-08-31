//! Session-file entry parser and parentId walk.
//!
//! `omp` records its journal as one JSON object per line, each carrying
//! `{type, id, parentId, timestamp}`. The `parentId` chain forms the active
//! branch — the latest-inserted entry is the live leaf, and walking its
//! `parentId` chain yields the conversation path the user is on.
//!
//! omp defines 15 entry types. The client acts on 7 (the ones the transcript
//! and switcher render); the other 8 are preserved whole so branch walks and
//! round-trips never lose data — a preserved entry still has `id`/`parentId`
//! and participates in the tree.
//!
//! Reference: `oh-my-pi/packages/coding-agent/src/session/session-entries.ts`
//! and `session-manager.ts:SessionEntryIndex.pathTo` (the walk).

export interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

/** The 7 entry types the client acts on. */
export type HandledEntry =
  | (SessionEntryBase & { kind: 'message'; message: unknown })
  | (SessionEntryBase & {
      kind: 'thinking_level_change';
      thinkingLevel: string | null;
      /** User-configured selector (`"auto"` or a level). Absent on old entries. */
      configured?: string | null;
    })
  | (SessionEntryBase & { kind: 'model_change'; model: unknown })
  | (SessionEntryBase & { kind: 'compaction'; reason?: string; result: unknown })
  | (SessionEntryBase & { kind: 'branch_summary'; summary?: string })
  | (SessionEntryBase & {
      kind: 'custom_message';
      customType?: string;
      content: unknown;
      display?: boolean;
    })
  | (SessionEntryBase & { kind: 'label'; targetId?: string; label?: string });

/**
 * The remaining 8 documented types (`service_tier_change`, `custom`,
 * `title_change`, `ttsr_injection`, `session_init`, `mode_change`,
 * `credential_pin`, `reset_boundary`) plus anything a future omp adds.
 * Kept whole: `raw` is the parsed line, untouched.
 */
export type PreservedEntry = SessionEntryBase & {
  kind: 'preserved';
  rawType: string;
  raw: Record<string, unknown>;
};

export type SessionEntry = HandledEntry | PreservedEntry;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Decode one session-file NDJSON line. Returns `null` for blank lines,
 * malformed JSON, and entries without an `id` — the journal is append-only
 * and one bad line must never abort the loader.
 */
export function decodeEntry(line: string): SessionEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let v: unknown;
  try {
    v = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  if (id === undefined) return null;
  const base: SessionEntryBase = {
    id,
    parentId: str(o.parentId) ?? null,
    timestamp: str(o.timestamp) ?? '',
  };

  const type = str(o.type) ?? '';
  switch (type) {
    case 'message':
      return { ...base, kind: 'message', message: o.message };
    case 'thinking_level_change':
      return {
        ...base,
        kind: 'thinking_level_change',
        thinkingLevel: str(o.thinkingLevel) ?? null,
        configured: o.configured === null ? null : str(o.configured),
      };
    case 'model_change':
      return { ...base, kind: 'model_change', model: o.model };
    case 'compaction':
      return { ...base, kind: 'compaction', reason: str(o.reason), result: o.result };
    case 'branch_summary':
      return { ...base, kind: 'branch_summary', summary: str(o.summary) };
    case 'custom_message':
      return {
        ...base,
        kind: 'custom_message',
        customType: str(o.customType),
        content: o.content,
        display: typeof o.display === 'boolean' ? o.display : undefined,
      };
    case 'label':
      return { ...base, kind: 'label', targetId: str(o.targetId), label: str(o.label) };
    default:
      return { ...base, kind: 'preserved', rawType: type, raw: o };
  }
}

/**
 * Live index over a session journal: id lookup, parent→children adjacency,
 * label resolution, and the active-leaf pointer.
 *
 * Mirrors `SessionEntryIndex` in omp's `session-manager.ts`: inserting an
 * entry always advances the leaf, and `pathTo()` is the parentId walk that
 * yields the active branch.
 */
export class SessionEntryIndex {
  private readonly byId = new Map<string, SessionEntry>();
  private readonly children = new Map<string | null, SessionEntry[]>();
  private readonly labels = new Map<string, string>();
  private leaf: string | null = null;

  rebuild(entries: readonly SessionEntry[]): void {
    this.byId.clear();
    this.children.clear();
    this.labels.clear();
    this.leaf = null;
    for (const e of entries) this.insert(e);
  }

  insert(entry: SessionEntry): void {
    this.byId.set(entry.id, entry);
    this.leaf = entry.id;
    const bucket = this.children.get(entry.parentId);
    if (bucket !== undefined) bucket.push(entry);
    else this.children.set(entry.parentId, [entry]);
    if (entry.kind === 'label' && entry.targetId !== undefined) {
      // An empty/absent label clears the previous one, as in omp.
      if (entry.label !== undefined && entry.label.length > 0) {
        this.labels.set(entry.targetId, entry.label);
      } else {
        this.labels.delete(entry.targetId);
      }
    }
  }

  get(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  leafId(): string | null {
    return this.leaf;
  }

  setLeaf(id: string | null): void {
    this.leaf = id;
  }

  childrenOf(parentId: string | null): SessionEntry[] {
    return [...(this.children.get(parentId) ?? [])];
  }

  labelFor(id: string): string | undefined {
    return this.labels.get(id);
  }

  /**
   * The parentId walk: from the given id (default: active leaf) back to the
   * root, reversed so the result reads root → leaf. This is the active
   * branch; siblings reached by `branch` commands hang off the same tree but
   * are not on this path.
   *
   * Cycle-safe: a parentId looping back into the walked prefix stops the
   * walk instead of spinning.
   */
  pathTo(id: string | null | undefined = this.leaf): SessionEntry[] {
    const out: SessionEntry[] = [];
    const seen = new Set<string>();
    let cursor = id !== null && id !== undefined ? this.byId.get(id) : undefined;
    while (cursor !== undefined && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      out.push(cursor);
      cursor = cursor.parentId !== null ? this.byId.get(cursor.parentId) : undefined;
    }
    return out.reverse();
  }
}
