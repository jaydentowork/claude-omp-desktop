// Parity: the TS decoder must decode `assets/fixtures/streaming-capture.ndjson`
// identically to the archived Rust `omp-rpc` crate + transcript model.
//
// The golden (`streaming-capture.golden.jsonl`) was emitted by compiling the
// Rust decoder from `T:\Code\OMP\claude-omp-desktop-gpui-archive` (branch
// `archive/gpui-rust`) against this same fixture and dumping every per-line
// decode result plus the settled transcript. Keys are sorted; this suite
// re-emits the identical structure from the TS port and diffs line by line.
// Zero frames misdecoded = zero diffs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameDecoder, type Frame, supportsV2 } from '../frame';
import {
  Coalescer,
  decodeEvent,
  TranscriptModel,
  type ChatMessage,
  type TranscriptEvent,
} from '../transcript';

const FIXTURE = readFileSync(
  join(__dirname, '../../../../../assets/fixtures/streaming-capture.ndjson'),
  'utf8',
);
const GOLDEN = readFileSync(join(__dirname, 'streaming-capture.golden.jsonl'), 'utf8');

// Mirrors the Rust Playback: flush the coalescer every 4th line to simulate
// the frame clock, so the streaming path is really exercised.
const FLUSH_EVERY = 4;

type Json = Record<string, unknown>;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Json = {};
    for (const k of Object.keys(value as Json).sort()) out[k] = sortKeys((value as Json)[k]);
    return out;
  }
  return value;
}

function frameJson(f: Frame): Json {
  switch (f.kind) {
    case 'ready':
      return {
        kind: 'ready',
        protocolVersion: f.ready.protocolVersion,
        supportedProtocolVersions: f.ready.supportedProtocolVersions ?? [],
        maxFrameBytes: f.ready.maxFrameBytes ?? null,
        maxReassembledFrameBytes: f.ready.maxReassembledFrameBytes ?? null,
        supportsV2: supportsV2(f.ready),
      };
    case 'response':
      return {
        kind: 'response',
        id: f.response.id ?? null,
        command: f.response.command,
        success: f.response.success,
        hasData: f.response.data !== undefined,
        error: f.response.error ?? null,
        code: f.response.code ?? null,
      };
    case 'unknown':
      return { kind: 'unknown', tag: f.tag };
  }
}

function eventJson(e: TranscriptEvent): Json {
  switch (e.event) {
    case 'agent_start':
      return { event: 'agent_start' };
    case 'agent_end':
      return { event: 'agent_end', isTerminal: e.isTerminal };
    case 'message_start':
      return { event: 'message_start', id: e.id, role: e.role };
    case 'message_update':
      return {
        event: 'message_update',
        id: e.id,
        textLen: Array.from(e.text).length,
        text: e.text,
      };
    case 'message_end':
      return { event: 'message_end', id: e.id, role: e.role, text: e.text };
    case 'tool_start':
      return { event: 'tool_start', toolCallId: e.toolCallId, name: e.name, summary: e.summary };
    case 'tool_end':
      return { event: 'tool_end', toolCallId: e.toolCallId, result: e.result };
    case 'other':
      return { event: 'other' };
  }
}

function rowJson(m: ChatMessage): Json {
  switch (m.row) {
    case 'text':
      return { row: 'text', id: m.id, role: m.role, text: m.text, streaming: m.streaming };
    case 'tool':
      return {
        row: 'tool',
        id: m.id,
        toolCallId: m.toolCallId,
        name: m.name,
        summary: m.summary,
        result: m.result,
        expanded: m.expanded,
      };
    case 'run_summary':
      return { row: 'run_summary', id: m.id, text: m.text };
  }
}

/** Replays the capture exactly as the Rust golden emitter does. */
function replay(capture: string): string[] {
  const decoder = new FrameDecoder();
  const model = new TranscriptModel();
  const coalescer = new Coalescer();
  const out: string[] = [];
  let sinceFlush = 0;

  const lines = capture.split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    let frame: Json;
    try {
      const f = decoder.feedLine(line);
      frame = f === null ? { kind: 'chunk_pending' } : frameJson(f);
    } catch (e) {
      frame = { kind: 'error', message: (e as Error).message };
    }

    const event = decodeEvent(line);
    const applied: Json[] = [];
    for (const e of coalescer.feed(event)) {
      model.apply(e);
      applied.push(eventJson(e));
    }
    sinceFlush += 1;
    if (sinceFlush >= FLUSH_EVERY) {
      sinceFlush = 0;
      const e = coalescer.flush();
      if (e !== null) {
        model.apply(e);
        applied.push(eventJson(e));
      }
    }

    out.push(JSON.stringify(sortKeys({ line: i, frame, decoded: eventJson(event), applied })));
  });
  const trailing = coalescer.flush();
  if (trailing !== null) {
    model.apply(trailing);
    out.push(JSON.stringify(sortKeys({ line: 'trailing_flush', applied: [eventJson(trailing)] })));
  }

  out.push(
    JSON.stringify(
      sortKeys({
        final: {
          streaming: model.streaming,
          streamingIndex: model.streamingIndex(),
          rows: model.messages.map(rowJson),
          coalescerFlushes: coalescer.flushes,
        },
      }),
    ),
  );
  return out;
}

describe('fixture parity vs the Rust decoder', () => {
  it('decodes every line of streaming-capture.ndjson identically to the golden', () => {
    const golden = GOLDEN.split('\n').filter((l) => l.length > 0);
    const ours = replay(FIXTURE);
    expect(ours.length).toBe(golden.length);
    // Line-by-line so a mismatch names the offending frame instead of
    // producing one giant diff.
    ours.forEach((line, i) => {
      expect(line, `frame ${i} misdecoded`).toBe(golden[i]);
    });
  });

  it('fixtures are LF-only (CRLF checkout guard)', () => {
    // The golden was emitted on Unix; git autocrlf turning it into CRLF on a
    // Windows checkout makes every line-by-line comparison fail. Guarded by
    // `-text` rules in .gitattributes — this fails loud if those regress.
    expect(GOLDEN.includes('\r'), 'golden contains CR — check .gitattributes *.jsonl -text').toBe(
      false,
    );
    expect(FIXTURE.includes('\r'), 'fixture contains CR — check .gitattributes *.ndjson -text').toBe(
      false,
    );
  });

  it('the capture is a real streaming turn (fixture guard)', () => {
    // If someone re-records the fixture without a streaming turn, the parity
    // test above becomes vacuous. Same guard as the Rust suite.
    const deltas = FIXTURE.split('\n').filter((l) => l.includes('"type":"text_delta"')).length;
    expect(deltas).toBeGreaterThan(20);
    expect(FIXTURE).toContain('"type":"agent_start"');
    expect(FIXTURE).toContain('"type":"agent_end"');
    expect(FIXTURE).toContain('extension_ui_request');
  });
});
