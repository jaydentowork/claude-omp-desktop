// Session-entry decoding: all 15 documented entry types at least once —
// 7 handled with typed fields, 8 preserved whole — plus the parentId walk
// that yields the active branch.

import { describe, expect, it } from 'vitest';
import { decodeEntry, SessionEntryIndex, type SessionEntry } from '../session';

let n = 0;
function entry(type: string, parentId: string | null, extra: Record<string, unknown> = {}): {
  line: string;
  id: string;
} {
  const id = `e${++n}`;
  return {
    id,
    line: JSON.stringify({ type, id, parentId, timestamp: `2026-08-31T00:00:${String(n).padStart(2, '0')}Z`, ...extra }),
  };
}

// One line per documented entry type, chained parent→child in order.
function allFifteen(): { lines: string[]; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  let parent: string | null = null;
  const add = (type: string, extra: Record<string, unknown> = {}) => {
    const e = entry(type, parent, extra);
    lines.push(e.line);
    ids.push(e.id);
    parent = e.id;
  };
  add('session_init', { cwd: 'C:\\repo' });
  add('message', { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  add('thinking_level_change', { thinkingLevel: 'high', configured: 'auto' });
  add('model_change', { model: { provider: 'anthropic', id: 'claude-sonnet-5' } });
  add('service_tier_change', { tier: 'priority' });
  add('compaction', { reason: 'threshold', result: { estimatedTokensAfter: 1000 } });
  add('branch_summary', { summary: 'earlier work' });
  add('reset_boundary');
  add('custom', { customType: 'ext', data: { x: 1 } });
  add('custom_message', { customType: 'slash', content: 'output', display: true });
  add('label', { targetId: 'e2', label: 'important' });
  add('title_change', { title: 'My session' });
  add('ttsr_injection', { rules: [] });
  add('mode_change', { mode: 'plan' });
  add('credential_pin', { credentialId: 'cred-1' });
  return { lines, ids };
}

const HANDLED = new Set([
  'message',
  'thinking_level_change',
  'model_change',
  'compaction',
  'branch_summary',
  'custom_message',
  'label',
]);

describe('the 15 entry types', () => {
  it('decodes every type: 7 handled, 8 preserved with the raw object intact', () => {
    const { lines } = allFifteen();
    expect(lines).toHaveLength(15);

    const entries = lines.map((l) => decodeEntry(l));
    expect(entries.every((e): e is SessionEntry => e !== null)).toBe(true);

    let handled = 0;
    let preserved = 0;
    for (const [i, e] of (entries as SessionEntry[]).entries()) {
      const rawType = (JSON.parse(lines[i]) as { type: string }).type;
      if (HANDLED.has(rawType)) {
        handled += 1;
        expect(e.kind, `expected ${rawType} to be handled`).toBe(rawType);
      } else {
        preserved += 1;
        expect(e.kind, `expected ${rawType} to be preserved`).toBe('preserved');
        if (e.kind !== 'preserved') continue;
        expect(e.rawType).toBe(rawType);
        // Preserved means whole: the raw parsed object round-trips.
        expect(e.raw).toEqual(JSON.parse(lines[i]));
      }
    }
    expect(handled).toBe(7);
    expect(preserved).toBe(8);
  });

  it('an undocumented future type is preserved, not dropped', () => {
    const e = decodeEntry(
      '{"type":"hologram_sync","id":"z1","parentId":null,"timestamp":"t","beam":42}',
    );
    expect(e?.kind).toBe('preserved');
    if (e?.kind !== 'preserved') return;
    expect(e.rawType).toBe('hologram_sync');
    expect((e.raw as { beam: number }).beam).toBe(42);
  });

  it('malformed lines and lines without an id return null instead of throwing', () => {
    expect(decodeEntry('')).toBeNull();
    expect(decodeEntry('not json')).toBeNull();
    expect(decodeEntry('{"type":"message"}')).toBeNull();
  });
});

describe('parentId walk for the active branch', () => {
  it('pathTo(leaf) walks parentId back to the root, in root→leaf order', () => {
    const { lines, ids } = allFifteen();
    const index = new SessionEntryIndex();
    index.rebuild(lines.map((l) => decodeEntry(l) as SessionEntry));

    // Inserting always advances the leaf, as in omp's SessionEntryIndex.
    expect(index.leafId()).toBe(ids[ids.length - 1]);

    const branch = index.pathTo();
    expect(branch.map((e) => e.id)).toEqual(ids);
    expect(branch[0].parentId).toBeNull();
  });

  it('a fork: only the active leaf chain is on the branch', () => {
    // root ── a ── b   (original branch)
    //          └── c ── d  (fork; d is the live leaf)
    const root = entry('session_init', null);
    const a = entry('message', root.id, { message: {} });
    const b = entry('message', a.id, { message: {} });
    const c = entry('message', a.id, { message: {} });
    const d = entry('message', c.id, { message: {} });
    const index = new SessionEntryIndex();
    index.rebuild([root, a, b, c, d].map((e) => decodeEntry(e.line) as SessionEntry));

    expect(index.pathTo().map((e) => e.id)).toEqual([root.id, a.id, c.id, d.id]);

    // Moving the leaf onto the abandoned sibling flips the branch.
    index.setLeaf(b.id);
    expect(index.pathTo().map((e) => e.id)).toEqual([root.id, a.id, b.id]);

    // Both children of `a` remain reachable through the tree.
    expect(index.childrenOf(a.id).map((e) => e.id)).toEqual([b.id, c.id]);
  });

  it('preserved entries participate in the walk', () => {
    // A branch threaded through a preserved (unhandled) entry type must not
    // break the chain — that is what "the rest preserved" buys us.
    const root = entry('session_init', null);
    const mid = entry('mode_change', root.id, { mode: 'plan' });
    const leaf = entry('message', mid.id, { message: {} });
    const index = new SessionEntryIndex();
    index.rebuild([root, mid, leaf].map((e) => decodeEntry(e.line) as SessionEntry));

    const branch = index.pathTo();
    expect(branch.map((e) => e.id)).toEqual([root.id, mid.id, leaf.id]);
    expect(branch[1].kind).toBe('preserved');
  });

  it('a parentId cycle stops the walk instead of spinning', () => {
    const x = decodeEntry('{"type":"message","id":"x","parentId":"y","timestamp":"t"}');
    const y = decodeEntry('{"type":"message","id":"y","parentId":"x","timestamp":"t"}');
    const index = new SessionEntryIndex();
    index.rebuild([x as SessionEntry, y as SessionEntry]);
    expect(index.pathTo().map((e) => e.id)).toEqual(['x', 'y']);
  });

  it('labels resolve and clear through label entries', () => {
    const root = entry('session_init', null);
    const set = entry('label', root.id, { targetId: root.id, label: 'v1' });
    const index = new SessionEntryIndex();
    index.rebuild([root, set].map((e) => decodeEntry(e.line) as SessionEntry));
    expect(index.labelFor(root.id)).toBe('v1');

    const clear = entry('label', set.id, { targetId: root.id });
    index.insert(decodeEntry(clear.line) as SessionEntry);
    expect(index.labelFor(root.id)).toBeUndefined();
  });
});
