// Subagent transcript dialog (docs/subagent-panel.md §4). Modal keyed by
// subagentId; reuses the transcript pane's renderer with a poll-driven
// backing source: full read on open, 250 ms incremental tail polls while
// running, one drain poll on terminal, freeze after.

import { useCallback, useEffect, useRef, useState } from 'react';
import { TranscriptModel, toolSummary, type ChatMessage } from '../main/omp-rpc';
import { usePanelStores } from './omp-provider';
import { TranscriptPane } from './transcript-pane';

export const POLL_INTERVAL_MS = 250;

interface MessagesResult {
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: unknown[];
}

/**
 * Fold a batch of complete `AgentMessage`s into the transcript model.
 * Subagent transcripts are session transcripts — same shape (spec §4) — but
 * they arrive as settled messages, not live events: text blocks become
 * settled text rows, toolCall blocks become tool rows, toolResult messages
 * complete their tool row.
 */
export function foldMessages(model: TranscriptModel, messages: unknown[]): void {
  for (const raw of messages) {
    const m = raw as {
      id?: unknown;
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
    };
    const role = typeof m.role === 'string' ? m.role : '';
    if (role === 'toolResult') {
      model.apply({
        event: 'tool_end',
        toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : '',
        result: blockText(m.content),
      });
      continue;
    }
    const id = typeof m.id === 'string' ? m.id : `anon:${model.messages.length}`;
    const text = blockText(m.content);
    if (text !== '') {
      model.apply({
        event: 'message_end',
        id,
        role: role === 'user' || role === 'assistant' ? role : 'custom',
        text,
      });
    }
    // Tool calls ride inside assistant content blocks in the recorded file
    // (no tool_execution_* events in a message fetch).
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        const block = b as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (block.type === 'toolCall' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name : 'tool';
          model.apply({
            event: 'tool_start',
            toolCallId: block.id,
            name,
            summary: toolSummary(name, block.arguments),
          });
        }
      }
    }
  }
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => {
      const o = b as { type?: unknown; text?: unknown };
      return o.type === 'text' && typeof o.text === 'string';
    })
    .map((b) => b.text)
    .join('');
}

export function SubagentTranscriptDialog({
  subagentId,
  onClose,
}: {
  subagentId: string;
  onClose: () => void;
}) {
  const { rpc, subagents } = usePanelStores();
  const [rows, setRows] = useState<readonly ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const modelRef = useRef(new TranscriptModel());

  const toggleTool = useCallback((toolCallId: string) => {
    modelRef.current.toggleTool(toolCallId);
    setRows([...modelRef.current.messages]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let nextByte: number | undefined;

    const poll = async (): Promise<void> => {
      try {
        const r = await rpc.request({
          type: 'get_subagent_messages',
          subagentId,
          ...(nextByte !== undefined ? { fromByte: nextByte } : {}),
        });
        if (cancelled) return;
        if (!r.success) {
          // Documented failures surface as a dismissable error; no auto
          // retry (spec §4).
          setError(r.error ?? 'get_subagent_messages failed');
          return;
        }
        const data = r.data as MessagesResult;
        if (data.reset) {
          // Session file rotated under us — discard and re-render (spec §4).
          modelRef.current = new TranscriptModel();
        }
        foldMessages(modelRef.current, data.messages ?? []);
        nextByte = data.nextByte;
        setRows([...modelRef.current.messages]);
        // Live tail while running; on terminal this very poll drained the
        // last frames, so stop (spec §4 step 5).
        const status = subagents.getRow(subagentId)?.status;
        const running = status === 'pending' || status === 'running';
        if (running) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [rpc, subagents, subagentId]);

  const row = subagents.getRow(subagentId);
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog subagent-dialog"
        role="dialog"
        aria-label="Subagent transcript"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <span>{row?.agentName ?? 'Agent'} transcript</span>
          <button type="button" className="titlebar-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {error !== null ? (
          <div className="dialog-error" role="alert">
            {error}
          </div>
        ) : (
          <TranscriptPane rows={rows} onToggleTool={toggleTool} />
        )}
      </div>
    </div>
  );
}
