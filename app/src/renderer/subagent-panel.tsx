// Subagent / background-tasks panel (docs/subagent-panel.md).
//
// Per-card subscriptions (spec §6): each card reads its own row via
// `useSyncExternalStore` keyed by id, so a `subagent_progress` frame
// re-renders one card, never the panel. The panel component re-renders only
// on group membership changes.

import { memo, useCallback, useState, useSyncExternalStore } from 'react';
import { usePanelStores } from './omp-provider';
import {
  formatDuration,
  formatTokens,
  type PanelRow,
  type SubagentStore,
} from './subagent-store';
import { SubagentTranscriptDialog } from './subagent-transcript-dialog';

export function SubagentPanel() {
  const { subagents } = usePanelStores();
  const groups = useSyncExternalStore(subagents.subscribe, subagents.getGroups);
  const [finishedOpen, setFinishedOpen] = useState(true);
  const [dialogId, setDialogId] = useState<string | null>(null);

  const openTranscript = useCallback((id: string) => setDialogId(id), []);

  if (!subagents.isSupported) {
    return <div className="tasks-empty">Subagent info unavailable on this omp build</div>;
  }

  return (
    <div className="subagent-panel">
      {groups.running.length > 0 && (
        <section aria-label="Running tasks">
          {groups.running.map((id) => (
            <SubagentCard key={id} id={id} store={subagents} onOpenTranscript={openTranscript} />
          ))}
        </section>
      )}
      {groups.finished.length > 0 && (
        <section aria-label="Finished tasks">
          <div className="finished-header">
            <button
              type="button"
              className="finished-toggle"
              aria-expanded={finishedOpen}
              onClick={() => setFinishedOpen((v) => !v)}
            >
              Finished {groups.finished.length} {finishedOpen ? '⌄' : '›'}
            </button>
            <button
              type="button"
              className="finished-clear"
              onClick={() => subagents.clearFinished()}
            >
              Clear
            </button>
          </div>
          {finishedOpen &&
            groups.finished.map((id) => (
              <SubagentCard key={id} id={id} store={subagents} onOpenTranscript={openTranscript} />
            ))}
        </section>
      )}
      {dialogId !== null && (
        <SubagentTranscriptDialog subagentId={dialogId} onClose={() => setDialogId(null)} />
      )}
    </div>
  );
}

/** Card labels per status (spec §2). */
function statusLabel(row: PanelRow, store: SubagentStore): string {
  switch (row.status) {
    case 'pending':
      return 'Queued';
    case 'running':
      return formatDuration(store.elapsedMs(row));
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Aborted';
  }
}

const SubagentCard = memo(function SubagentCard({
  id,
  store,
  onOpenTranscript,
}: {
  id: string;
  store: SubagentStore;
  onOpenTranscript: (id: string) => void;
}) {
  // Per-row subscription: this card re-renders on its own row's rev bumps
  // (progress frames + the 1 Hz elapsed ticker), nothing else's.
  const row = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribeRow(id, cb), [store, id]),
    // rev is the snapshot: the row object is mutated in place, so the memo
    // key has to be a changing primitive, same trick as the transcript rows.
    () => store.getRow(id)?.rev ?? -1,
  );
  void row;
  const data = store.getRow(id);
  if (data === undefined) return null;

  const p = data.lastProgress;
  const isTerminal = data.status === 'completed' || data.status === 'failed' || data.status === 'aborted';
  return (
    <div className="subagent-card" data-status={data.status}>
      <div className="card-title">
        <span className="card-agent">{data.agentName}</span>
        <span className="card-status">{statusLabel(data, store)}</span>
      </div>
      {data.task !== '' && <div className="card-task">{data.task}</div>}
      {isTerminal && (
        <div className="card-meta">
          {data.status === 'completed' && p !== undefined && (
            <span>
              {formatTokens(p.tokens)} tokens · {p.toolCount} tool uses
            </span>
          )}
          <button type="button" className="card-link" onClick={() => onOpenTranscript(id)}>
            View transcript
          </button>
        </div>
      )}
    </div>
  );
});
