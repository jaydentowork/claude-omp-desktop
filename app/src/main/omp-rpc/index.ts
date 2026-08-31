//! `omp-rpc`: TS port of the archived Rust `omp-rpc` crate plus the
//! transcript/session layers the desktop client decodes with.
//!
//! Deliberately free of any Electron dependency so the protocol layer can be
//! tested headlessly against recorded NDJSON.

export {
  decodeFrame,
  FrameDecoder,
  DecodeError,
  supportsV2,
  base64Decode,
  MAX_PHYSICAL_FRAME_BYTES,
  MAX_REASSEMBLED_FRAME_BYTES,
} from './frame';
export type { Frame, Ready, Response, DecodeErrorKind } from './frame';

export { TranscriptModel, Coalescer, decodeEvent, toolSummary } from './transcript';
export type { ChatMessage, TranscriptEvent, Role } from './transcript';

export { decodeEntry, SessionEntryIndex } from './session';
export type { SessionEntry, HandledEntry, PreservedEntry, SessionEntryBase } from './session';
