// Transcript pane — virtualized list fed by `OmpProvider`'s transcript
// snapshot. Rows are memoized by `(message.id, message.revision)`; the
// streaming tail is the only one whose props change per flush.
//
// Layout lives entirely in CSS (see `index.css`): pane geometry is fixed by
// `docs/transcript-rendering.md` §1 (pane header 44 px, list flex, composer
// slot 88 px reserved below — composer itself ships with another slice).

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import { useVirtualizer } from '@tanstack/react-virtual';
import { code } from '@streamdown/code';
import { useOmpStore, useOmpStream } from './omp-provider';
import type { ChatMessage } from '../main/omp-rpc';

interface Props {
  /** Reserved slot above the list (header); 44 px per spec §1. */
  header?: ReactNode;
  /** Reserved slot below the list (composer + git strip); 88 px per spec §1. */
  footer?: ReactNode;
  /** Override the backing rows: the subagent transcript dialog reuses this
   * renderer with its own message-fetch loop (docs/subagent-panel.md §4).
   * Absent → the session stream from `OmpProvider`. */
  rows?: readonly ChatMessage[];
  /** Streaming flag paired with `rows`; ignored when `rows` is absent. */
  rowsStreaming?: boolean;
  /** Tool-collapse toggle paired with `rows`; defaults to the session store. */
  onToggleTool?: (toolCallId: string) => void;
}

export function TranscriptPane({ header, footer, rows, rowsStreaming, onToggleTool }: Props) {
  const stream = useOmpStream();
  const messages = rows ?? stream.messages;
  const streaming = rows !== undefined ? rowsStreaming ?? false : stream.streaming;
  const store = useOmpStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    // Per docs §4.1: pinned to the tail during streaming, but do not pull
    // the viewport when the user has scrolled up to read history.
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 4,
    overscan: 12,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (el === null) return;
    const update = () => setAtEnd(virtualizer.isAtEnd());
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, [virtualizer]);

  const scrollToEnd = useCallback(() => {
    if (messages.length === 0) return;
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }, [messages.length, virtualizer]);

  const toggleTool = useCallback(
    (toolCallId: string) => {
      if (onToggleTool !== undefined) onToggleTool(toolCallId);
      else store.toggleTool(toolCallId);
    },
    [store, onToggleTool],
  );

  return (
    <div className="transcript-pane">
      {header !== undefined && <div className="pane-header">{header}</div>}
      <div ref={parentRef} className="transcript-scroll" data-testid="transcript-scroll">
        <div
          className="transcript-vlist"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const msg = messages[vi.index];
            if (msg === undefined) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="row-wrap"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <MessageRow message={msg} onToggleTool={toggleTool} />
              </div>
            );
          })}
        </div>
        {streaming && messages.length === 0 && (
          <div className="empty">Waiting for the agent…</div>
        )}
        {!atEnd && messages.length > 0 && (
          <button
            type="button"
            className="scroll-to-bottom"
            aria-label="Scroll to bottom"
            onClick={scrollToEnd}
          >
            ↓
          </button>
        )}
      </div>
      {footer !== undefined && <div className="pane-footer">{footer}</div>}
    </div>
  );
}

interface RowProps {
  message: ChatMessage;
  onToggleTool: (toolCallId: string) => void;
}

const MessageRow = memo(function MessageRow({ message, onToggleTool }: RowProps) {
  switch (message.row) {
    case 'text':
      return <TextRow message={message} />;
    case 'tool':
      return <ToolRow message={message} onToggle={onToggleTool} />;
    case 'notice':
      return <NoticeRow message={message} />;
    case 'run_summary':
      return <RunSummaryRow message={message} />;
  }
}, (prev, next) => {
  // Rows are mutated in place by the model (hot-path requirement), so
  // reference equality alone would miss content changes. `(id, rev)` is the
  // spec's memo key (§4.2 step 3): settled rows never bump `rev`, so their
  // subtrees stay frozen; only the streaming tail re-renders.
  return (
    prev.message.id === next.message.id &&
    prev.message.rev === next.message.rev &&
    prev.onToggleTool === next.onToggleTool
  );
});

function TextRow({ message }: { message: Extract<ChatMessage, { row: 'text' }> }) {
  if (message.role === 'user') {
    return (
      <div className="row row-user">
        <div className="user-bubble">{message.text}</div>
      </div>
    );
  }
  if (message.role === 'custom') {
    // irc_message / custom-type system notice: render the body verbatim, no
    // markdown — these are upstream-pinned safety wrappers (the recorded
    // capture wraps a `<system-notice>` body, for example).
    return <div className="row row-notice">{message.text}</div>;
  }
  return (
    <div className="row row-assistant">
      <Streamdown
        isAnimating={message.streaming}
        plugins={message.streaming ? undefined : { code }}
        components={{ p: ({ children }) => <p className="md-p">{children}</p> }}
      >
        {message.text}
      </Streamdown>
    </div>
  );
}

function ToolRow({
  message,
  onToggle,
}: {
  message: Extract<ChatMessage, { row: 'tool' }>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="row row-tool" data-expanded={message.expanded}>
      <button
        type="button"
        className="tool-pill"
        aria-expanded={message.expanded}
        onClick={() => onToggle(message.toolCallId)}
      >
        <span className="tool-name">{message.name}</span>
        {message.summary !== '' && (
          <>
            {' '}
            <span className="tool-summary">{message.summary}</span>
          </>
        )}
        <span className="tool-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {message.expanded && message.result !== null && (
        <pre className="tool-result">{message.result}</pre>
      )}
    </div>
  );
}

function NoticeRow({ message }: { message: Extract<ChatMessage, { row: 'notice' }> }) {
  return (
    <div className="row row-notice" data-level={message.level} role="status">
      {message.text}
    </div>
  );
}

function RunSummaryRow({
  message,
}: {
  message: Extract<ChatMessage, { row: 'run_summary' }>;
}) {
  return <div className="row row-run-summary">{message.text}</div>;
}