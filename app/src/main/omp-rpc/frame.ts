//! Frame decoding for `omp --mode rpc-ui` (NDJSON over stdio).
//!
//! Port of the archived Rust `omp-rpc` crate's `frame.rs` (branch
//! `archive/gpui-rust`). One JSON object per line on the wire; after protocol
//! v2 negotiation, oversized objects arrive split across `rpc_chunk` frames
//! carrying base64 segments, which `FrameDecoder` reassembles.
//!
//! Frames are correlated by `id`, never by emission order — `bash` dispatches
//! concurrently, so responses can overtake each other. See `docs/rpc-events.md`.

/** Physical per-line cap omp advertises in its `ready` frame. */
export const MAX_PHYSICAL_FRAME_BYTES = 1 << 20; // 1 MiB

/**
 * Ceiling on a reassembled logical frame. Larger payloads must be paged at
 * the command level (`get_messages_page`), not fetched as one frame.
 */
export const MAX_REASSEMBLED_FRAME_BYTES = 64 << 20; // 64 MiB

/**
 * A decoded frame. Typed where the app acts on the contents, `unknown`
 * otherwise — omp emits frame types beyond the documented set (extensions
 * add their own), and an unrecognised frame must never kill the stream.
 */
export type Frame =
  | { kind: 'ready'; ready: Ready }
  | { kind: 'response'; response: Response }
  | { kind: 'unknown'; tag: string; raw: unknown };

export interface Ready {
  protocolVersion: number;
  supportedProtocolVersions?: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
}

/** Whether the server can be negotiated up to protocol v2. */
export function supportsV2(ready: Ready): boolean {
  return (ready.supportedProtocolVersions ?? []).includes(2);
}

export interface Response {
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Machine-readable failure code. Only `session_busy` and `stale_cursor`
   * are documented; match on this, never on `error` text.
   */
  code?: string;
}

export type DecodeErrorKind =
  | 'frame_too_large'
  | 'not_json'
  /**
   * A chunk sequence was interleaved, duplicated, out of order, or
   * interrupted by a non-chunk frame.
   */
  | 'chunk_protocol'
  | 'reassembled_too_large';

export class DecodeError extends Error {
  readonly kind: DecodeErrorKind;
  constructor(kind: DecodeErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'DecodeError';
  }
}

/**
 * Decode one physical NDJSON line into a logical frame. Pure and synchronous.
 *
 * `rpc_chunk` lines are stateful by nature and rejected here — feed those
 * through a `FrameDecoder`, which uses this same classification once a
 * sequence completes.
 */
export function decodeFrame(line: string): Frame {
  const value = parseLine(line);
  const tag = frameTag(value);
  if (tag === 'rpc_chunk') {
    throw new DecodeError('chunk_protocol', 'rpc_chunk requires a stateful FrameDecoder');
  }
  return classify(tag, value);
}

interface Chunk {
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface Pending {
  chunkId: string;
  parts: Array<Uint8Array | null>;
}

/**
 * Stateful line decoder. Feed whole lines; get back logical frames.
 * Returns `null` while a chunk sequence is still being assembled.
 */
export class FrameDecoder {
  private pending: Pending | null = null;

  feedLine(line: string): Frame | null {
    const value = parseLine(line);
    const tag = frameTag(value);

    if (tag === 'rpc_chunk') {
      return this.absorbChunk(value);
    }
    // A non-chunk frame while a sequence is open means the server
    // interrupted it; the spec requires an uninterrupted run.
    if (this.pending !== null) {
      this.pending = null;
      throw new DecodeError('chunk_protocol', `non-chunk frame \`${tag}\` arrived mid-sequence`);
    }
    return classify(tag, value);
  }

  private absorbChunk(value: Record<string, unknown>): Frame | null {
    const chunk = parseChunk(value);

    if (chunk.count === 0) {
      throw new DecodeError('chunk_protocol', 'count is zero');
    }

    if (this.pending !== null && this.pending.chunkId !== chunk.chunkId) {
      const previous = this.pending.chunkId;
      this.pending = null;
      throw new DecodeError('chunk_protocol', `interleaved sequences: ${previous} then ${chunk.chunkId}`);
    }
    if (this.pending !== null && this.pending.parts.length !== chunk.count) {
      this.pending = null;
      throw new DecodeError('chunk_protocol', 'count changed mid-sequence');
    }
    if (this.pending === null && chunk.index !== 0) {
      throw new DecodeError('chunk_protocol', `sequence ${chunk.chunkId} starts at index ${chunk.index}`);
    }

    if (this.pending === null) {
      this.pending = { chunkId: chunk.chunkId, parts: new Array<Uint8Array | null>(chunk.count).fill(null) };
    }
    if (chunk.index >= this.pending.parts.length) {
      throw new DecodeError('chunk_protocol', `index ${chunk.index} out of range`);
    }
    if (this.pending.parts[chunk.index] !== null) {
      throw new DecodeError('chunk_protocol', `duplicate index ${chunk.index}`);
    }

    const decoded = base64Decode(chunk.data);
    if (decoded === null) {
      throw new DecodeError('chunk_protocol', 'data is not valid base64');
    }
    if (decoded.length !== chunk.byteLength) {
      throw new DecodeError('chunk_protocol', `byteLength says ${chunk.byteLength} but decoded ${decoded.length}`);
    }
    this.pending.parts[chunk.index] = decoded;

    if (this.pending.parts.some((p) => p === null)) {
      return null;
    }

    // Complete: concatenate in index order, then parse as one object.
    const parts = this.pending.parts as Uint8Array[];
    this.pending = null;
    const total = parts.reduce((n, p) => n + p.length, 0);
    if (total > MAX_REASSEMBLED_FRAME_BYTES) {
      throw new DecodeError('reassembled_too_large', `reassembled frame of ${total} bytes exceeds 64 MiB cap`);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.length;
    }
    let text: string;
    try {
      // strict UTF-8, per spec: invalid bytes are a chunk-protocol error
      text = new TextDecoder('utf-8', { fatal: true }).decode(merged);
    } catch {
      throw new DecodeError('chunk_protocol', 'reassembled bytes are not UTF-8');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new DecodeError('not_json', `reassembled: ${String(e)}`);
    }
    const obj = asObject(parsed, 'reassembled frame is not a JSON object');
    return classify(frameTag(obj), obj);
  }
}

function parseLine(line: string): Record<string, unknown> {
  // The Rust decoder caps on byte length; JS strings are UTF-16, so measure
  // UTF-8 bytes only when the character count alone could exceed the cap.
  if (line.length > MAX_PHYSICAL_FRAME_BYTES) {
    throw new DecodeError('frame_too_large', `line of ${line.length} chars exceeds 1 MiB cap`);
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (e) {
    throw new DecodeError('not_json', `line is not valid JSON: ${String(e)}`);
  }
  return asObject(value, 'line is not a JSON object');
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecodeError('not_json', message);
  }
  return value as Record<string, unknown>;
}

function frameTag(value: Record<string, unknown>): string {
  return typeof value.type === 'string' ? value.type : '';
}

function parseChunk(value: Record<string, unknown>): Chunk {
  const { chunkId, index, count, byteLength, data } = value as Partial<Chunk>;
  if (
    typeof chunkId !== 'string' ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    !Number.isInteger(byteLength) ||
    typeof data !== 'string'
  ) {
    throw new DecodeError('chunk_protocol', 'malformed chunk');
  }
  return { chunkId, index: index as number, count: count as number, byteLength: byteLength as number, data };
}

function classify(tag: string, value: Record<string, unknown>): Frame {
  // The Rust decoder falls back to Unknown when a `ready`/`response` frame
  // fails to deserialize; here the minimal structural checks below mirror
  // serde's required-field validation.
  if (tag === 'ready' && typeof value.protocolVersion === 'number') {
    return { kind: 'ready', ready: value as unknown as Ready };
  }
  if (tag === 'response' && typeof value.command === 'string' && typeof value.success === 'boolean') {
    return { kind: 'response', response: value as unknown as Response };
  }
  return { kind: 'unknown', tag, raw: value };
}

/**
 * Minimal standard base64 decoder, ported byte-for-byte from the Rust helper:
 * whitespace stripped, length must be a multiple of 4, `=` contributes zero
 * bits, more than two `=` in a quad rejects.
 */
export function base64Decode(s: string): Uint8Array | null {
  const val = (c: number): number | null => {
    if (c >= 0x41 && c <= 0x5a) return c - 0x41; // A-Z
    if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26; // a-z
    if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52; // 0-9
    if (c === 0x2b) return 62; // +
    if (c === 0x2f) return 63; // /
    return null;
  };
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x0b) continue;
    if (c > 0x7f) return null;
    bytes.push(c);
  }
  if (bytes.length % 4 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    const quad = bytes.slice(i, i + 4);
    const pad = quad.filter((c) => c === 0x3d).length;
    if (pad > 2) return null;
    let acc = 0;
    for (const c of quad) {
      const v = c === 0x3d ? 0 : val(c);
      if (v === null) return null;
      acc = (acc << 6) | v;
    }
    out.push((acc >> 16) & 0xff);
    if (pad < 2) out.push((acc >> 8) & 0xff);
    if (pad < 1) out.push(acc & 0xff);
  }
  return new Uint8Array(out);
}
