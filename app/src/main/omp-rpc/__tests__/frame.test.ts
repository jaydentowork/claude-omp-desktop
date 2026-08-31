// Ports the Rust `decode-recorded-session.rs` chunk/error tests, plus
// `decodeFrame` coverage. The fixture-level parity lives in
// `fixture-parity.test.ts`.

import { describe, expect, it } from 'vitest';
import { decodeFrame, DecodeError, FrameDecoder, supportsV2 } from '../frame';

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function chunkLine(chunkId: string, index: number, count: number, part: Uint8Array): string {
  return JSON.stringify({
    type: 'rpc_chunk',
    chunkId,
    index,
    count,
    byteLength: part.length,
    data: b64(part),
  });
}

describe('decodeFrame', () => {
  it('types a ready frame and reads v2 support', () => {
    const frame = decodeFrame(
      '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576}',
    );
    expect(frame.kind).toBe('ready');
    if (frame.kind !== 'ready') return;
    expect(frame.ready.protocolVersion).toBe(1);
    expect(frame.ready.maxFrameBytes).toBe(1 << 20);
    expect(supportsV2(frame.ready)).toBe(true);
  });

  it('types a response frame', () => {
    const frame = decodeFrame(
      '{"type":"response","id":"r1","command":"get_state","success":true,"data":{}}',
    );
    expect(frame.kind).toBe('response');
    if (frame.kind !== 'response') return;
    expect(frame.response.id).toBe('r1');
    expect(frame.response.command).toBe('get_state');
    expect(frame.response.success).toBe(true);
  });

  it('keeps unknown frame types whole instead of aborting the stream', () => {
    const frame = decodeFrame('{"type":"some_future_frame","payload":42}');
    expect(frame.kind).toBe('unknown');
    if (frame.kind !== 'unknown') return;
    expect(frame.tag).toBe('some_future_frame');
    expect((frame.raw as { payload: number }).payload).toBe(42);
  });

  it('falls back to unknown when a typed frame misses required fields', () => {
    // Mirrors serde's required-field validation: a `response` without
    // `command`/`success` must not crash, and must stay preserved.
    const frame = decodeFrame('{"type":"response","id":"r1"}');
    expect(frame.kind).toBe('unknown');
  });

  it('rejects non-JSON lines', () => {
    expect(() => decodeFrame('not json')).toThrowError(DecodeError);
  });

  it('rejects rpc_chunk lines — those need the stateful decoder', () => {
    expect(() => decodeFrame('{"type":"rpc_chunk","chunkId":"c","index":0,"count":1,"byteLength":1,"data":"eA=="}')).toThrowError(DecodeError);
  });
});

describe('FrameDecoder chunk reassembly', () => {
  it('reassembles a chunked frame', () => {
    const body = Buffer.from('{"type":"response","command":"x","success":true}');
    const a = body.subarray(0, 20);
    const b = body.subarray(20);
    const decoder = new FrameDecoder();

    expect(decoder.feedLine(chunkLine('c1', 0, 2, a))).toBeNull();
    const frame = decoder.feedLine(chunkLine('c1', 1, 2, b));
    expect(frame?.kind).toBe('response');
    if (frame?.kind !== 'response') return;
    expect(frame.response.command).toBe('x');
  });

  it('rejects interleaved chunk sequences', () => {
    const decoder = new FrameDecoder();
    decoder.feedLine(chunkLine('a', 0, 2, Buffer.from('x')));
    expect(() => decoder.feedLine(chunkLine('b', 0, 2, Buffer.from('x')))).toThrowError(
      DecodeError,
    );
  });

  it('rejects a non-chunk frame arriving mid-sequence', () => {
    const decoder = new FrameDecoder();
    decoder.feedLine(chunkLine('a', 0, 2, Buffer.from('x')));
    expect(() => decoder.feedLine('{"type":"notice","message":"hi"}')).toThrowError(DecodeError);
    // The decoder recovers: the next ordinary frame decodes fine.
    expect(decoder.feedLine('{"type":"notice","message":"hi"}')?.kind).toBe('unknown');
  });

  it('rejects a byteLength mismatch — the field is load-bearing', () => {
    const decoder = new FrameDecoder();
    const bad =
      '{"type":"rpc_chunk","chunkId":"c","index":0,"count":1,"byteLength":99,"data":"eA=="}';
    expect(() => decoder.feedLine(bad)).toThrowError(DecodeError);
  });

  it('rejects a sequence starting at a nonzero index', () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.feedLine(chunkLine('c', 1, 2, Buffer.from('x')))).toThrowError(
      DecodeError,
    );
  });

  it('rejects a duplicate chunk index', () => {
    const decoder = new FrameDecoder();
    decoder.feedLine(chunkLine('c', 0, 2, Buffer.from('x')));
    expect(() => decoder.feedLine(chunkLine('c', 0, 2, Buffer.from('x')))).toThrowError(
      DecodeError,
    );
  });
});
