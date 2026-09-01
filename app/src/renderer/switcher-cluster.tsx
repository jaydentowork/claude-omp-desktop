// Model + thinking switcher cluster (docs/model-thinking-switcher.md).
// The two right-most text elements of the status-bar controls cluster
// (window-shell decision 5): clicking the model label opens the model
// picker, clicking the effort label opens the thinking picker. Both
// popovers drop upward from the bottom bar.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { usePanelStores } from './omp-provider';
import {
  displayLevel,
  THINKING_LEVELS,
  type CatalogModel,
  type SwitcherStore,
  type ThinkingLevel,
} from './switcher-store';

export function SwitcherCluster() {
  const { switcher } = usePanelStores();
  const state = useSyncExternalStore(switcher.subscribe, switcher.getState);
  const [open, setOpen] = useState<'model' | 'thinking' | null>(null);

  const openModelPicker = useCallback(async () => {
    // Refetched each open: `omp login` in a terminal can change the catalog
    // (spec §2.2). Fetch failure → popover does not open, notice shows.
    const ok = await switcher.refreshCatalog();
    if (ok) setOpen('model');
  }, [switcher]);

  if (!state.alive) {
    return (
      <div className="switcher-cluster" data-dead="true">
        <span className="model-chip switcher-dead">{state.modelLabel || 'Model'}</span>
        <span className="model-chip switcher-dead">
          {state.thinkingLevel !== null ? displayLevel(state.thinkingLevel) : 'Effort'}
        </span>
      </div>
    );
  }

  return (
    <div className="switcher-cluster">
      {state.notice !== null && (
        <span className="switcher-notice" role="status">
          {state.notice}
        </span>
      )}
      <button
        type="button"
        className="model-chip switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open === 'model'}
        onClick={() => (open === 'model' ? setOpen(null) : void openModelPicker())}
      >
        {state.modelLabel || 'Model'}
      </button>
      <button
        type="button"
        className="model-chip switcher-trigger"
        aria-haspopup="dialog"
        aria-expanded={open === 'thinking'}
        onClick={() => setOpen(open === 'thinking' ? null : 'thinking')}
      >
        {state.thinkingLevel !== null ? displayLevel(state.thinkingLevel) : 'Effort'}
      </button>
      {open === 'model' && (
        <ModelPicker
          store={switcher}
          catalog={state.catalog}
          currentLabel={state.modelLabel}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'thinking' && (
        <ThinkingPicker
          store={switcher}
          level={state.thinkingLevel ?? 'medium'}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** Model picker popover (spec §2): server-ordered rows, hotkeys 1–9,
 * ↑/↓ + Enter, checkmark on the current model. */
function ModelPicker({
  store,
  catalog,
  currentLabel,
  onClose,
}: {
  store: SwitcherStore;
  catalog: readonly CatalogModel[];
  currentLabel: string;
  onClose: () => void;
}) {
  const currentIx = Math.max(0, catalog.findIndex((m) => m.name === currentLabel));
  const [highlight, setHighlight] = useState(currentIx);
  const ref = useRef<HTMLDivElement>(null);

  const commit = useCallback(
    (model: CatalogModel | undefined) => {
      if (model === undefined) return;
      // Optimistic paint + reconcile all happen in the store; the popover
      // just closes (spec §2.3 step 1).
      void store.setModel(model);
      onClose();
    },
    [store, onClose],
  );

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'Enter') return commit(catalog[highlight]);
    if (e.key === 'ArrowUp') return setHighlight((h) => Math.max(0, h - 1));
    if (e.key === 'ArrowDown') return setHighlight((h) => Math.min(catalog.length - 1, h + 1));
    // Numeric hotkeys 1–9 commit that row directly (spec §2.1).
    const n = Number.parseInt(e.key, 10);
    if (n >= 1 && n <= 9) commit(catalog[n - 1]);
  };

  return (
    <div
      ref={ref}
      className="picker-popover model-picker"
      role="listbox"
      aria-label="Models"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="picker-header">Models</div>
      <div className="picker-rows">
        {catalog.map((m, i) => (
          <button
            key={`${m.provider}/${m.id}`}
            type="button"
            role="option"
            aria-selected={i === currentIx}
            className="picker-row"
            data-highlighted={i === highlight}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => commit(m)}
          >
            <span className="picker-name">{m.name}</span>
            {i === currentIx ? (
              <span className="picker-check" aria-hidden="true">
                ✓
              </span>
            ) : (
              i < 9 && <span className="picker-hotkey">{i + 1}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Thinking picker popover (spec §3): seven-detent slider, event-driven
 * commit — the label follows `thinking_level_changed`, the popover closes
 * when the store confirms. */
function ThinkingPicker({
  store,
  level,
  onClose,
}: {
  store: SwitcherStore;
  level: ThinkingLevel;
  onClose: () => void;
}) {
  const [handle, setHandle] = useState<ThinkingLevel>(level);
  const [busy, setBusy] = useState(false);

  const commit = async (next: ThinkingLevel) => {
    setHandle(next);
    setBusy(true);
    const ok = await store.setThinkingLevel(next);
    setBusy(false);
    // On success the label updates from the event and the popover closes;
    // on failure the handle snaps back and the popover stays open (§3.2).
    if (ok) onClose();
    else setHandle(level);
  };

  return (
    <div
      className="picker-popover thinking-picker"
      role="dialog"
      aria-label="Effort"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="picker-header">
        <strong>Effort</strong> {displayLevel(handle)}
        <span className="picker-help" title="Higher effort thinks longer; lower responds faster.">
          ?
        </span>
      </div>
      <div className="thinking-slider" data-busy={busy}>
        <span className="thinking-end">Faster</span>
        <input
          type="range"
          min={0}
          max={THINKING_LEVELS.length - 1}
          step={1}
          value={THINKING_LEVELS.indexOf(handle)}
          aria-label="Thinking level"
          aria-valuetext={displayLevel(handle)}
          disabled={busy}
          // Title updates live while dragging; the commit happens on release
          // (pointer up / key up), per spec §3.2.
          onChange={(e) => {
            const next = THINKING_LEVELS[Number(e.target.value)];
            if (next !== undefined) setHandle(next);
          }}
          onPointerUp={() => void commit(handle)}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
              void commit(handle);
            }
          }}
        />
        <span className="thinking-end">Smarter</span>
      </div>
    </div>
  );
}
