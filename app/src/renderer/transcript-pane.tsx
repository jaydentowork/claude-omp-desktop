// Transcript pane — virtualized list fed by `OmpProvider`'s transcript
// snapshot. Rows are memoized by `(message.id, message.revision)`; the
// streaming tail is the only one whose props change per flush.
//
// Layout lives entirely in CSS (see `index.css`): pane geometry is fixed by
// `docs/transcript-rendering.md` §1 (pane header 44 px, list flex, composer
// slot 88 px reserved below — composer itself ships with another slice).

import { memo, useCallback, useRef, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useOmpStore, useOmpStream } from './omp-provider';
import type { ChatMessage } from '../main/omp-rpc';

interface Props {
  /** Reserved slot above the list (header); 44 px per spec §1. */
  header?: ReactNode;
  /** Reserved slot below the list (composer + git strip); 88 px per spec §1. */
  footer?: ReactNode;
}

export function TranscriptPane({ header, footer }: Props) {
  const { messages, streaming } = useOmpStream();
  const store = useOmpStore();
  const parentRef = useRef<HTMLDivElement>(null);

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

  const toggleTool = useCallback(
    (toolCallId: string) => store.toggleTool(toolCallId),
    [store],
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
  return (
    <div className="row row-assistant">
      <Streamdown
        isAnimating={message.streaming}
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

function RunSummaryRow({
  message,
}: {
  message: Extract<ChatMessage, { row: 'run_summary' }>;
}) {
  return <div className="row row-run-summary">{message.text}</div>;
}