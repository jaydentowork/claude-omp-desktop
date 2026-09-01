// Window shell — pane framing (issue #22, docs/window-shell.md decisions 3+5).
// Grid `sidebar (288) | transcript (flex) | tasks (283)` between the 44 px
// titlebar and the 33 px status bar. Collapse is in-memory state only;
// resizability + persistence are deferred (window-shell §3) until a user
// complains about the fixed widths.
//
// Region contents are other slices: sidebar sessions, tasks panel content and
// the composer each ship separately — this file frames the regions and wires
// the collapse affordances (titlebar toggle for sidebar, panel-header button
// for tasks).

import { useState } from 'react';
import { TranscriptPane } from './transcript-pane';
import { Composer } from './composer';
import { useOmpStream } from './omp-provider';
import { SubagentPanel } from './subagent-panel';
import { SwitcherCluster } from './switcher-cluster';

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);

  return (
    <div className="app-shell">
      <Titlebar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div
        className="pane-grid"
        data-sidebar={sidebarOpen ? 'open' : 'collapsed'}
        data-tasks={tasksOpen ? 'open' : 'collapsed'}
      >
        {sidebarOpen && <Sidebar />}
        <TranscriptPane header={<TranscriptHeader />} footer={<PaneFooter />} />
        {tasksOpen && <TasksPanel onCollapse={() => setTasksOpen(false)} />}
      </div>
      <StatusBar />
      {!tasksOpen && (
        <button
          type="button"
          className="tasks-reopen"
          aria-label="Show tasks panel"
          onClick={() => setTasksOpen(true)}
        >
          ‹
        </button>
      )}
    </div>
  );
}

/** 44 px custom titlebar under the WCO caption buttons (window-shell
 * decision 1). Left: navigation cluster. The model/thinking controls live in
 * the status bar (window-shell decision 5, wired by the switcher slice). */
function Titlebar({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <div className="titlebar">
      <div className="titlebar-nav">
        <button
          type="button"
          className="titlebar-btn"
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          ☰
        </button>
        <button type="button" className="titlebar-btn" aria-label="Search" disabled>
          ⌕
        </button>
        <button type="button" className="titlebar-btn" aria-label="Back" disabled>
          ‹
        </button>
        <button type="button" className="titlebar-btn" aria-label="Forward" disabled>
          ›
        </button>
      </div>
    </div>
  );
}

/** Session sidebar frame (288 px). Contents are the session-sidebar slice;
 * the dev build shows the single hardcoded project group (window-shell §4). */
function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="sidebar-group-header">abm</div>
    </aside>
  );
}

/** Tasks panel frame (283 px) with its own 44 px header carrying the
 * collapse button (window-shell §3). Contents: the subagent panel
 * (docs/subagent-panel.md). */
function TasksPanel({ onCollapse }: { onCollapse: () => void }) {
  return (
    <aside className="tasks-panel" aria-label="Tasks">
      <div className="tasks-header">
        <span>Tasks</span>
        <button
          type="button"
          className="titlebar-btn"
          aria-label="Hide tasks panel"
          onClick={onCollapse}
        >
          ›
        </button>
      </div>
      <SubagentPanel />
    </aside>
  );
}

/** Transcript pane header: session title + project chip (window-shell
 * decision 2 — the title lives here, not in a tab strip). */
function TranscriptHeader() {
  return (
    <>
      <span className="session-title">Session</span>
      <span className="session-chip">abm</span>
    </>
  );
}

/** 88 px composer + git-strip slot (window-shell decision 6): 44 px composer
 * (issue #23), 10 px gap, 34 px dimmed git-strip card below it — deferred,
 * not MVP, but its space stays visible. Order matches the measured screenshot
 * (composer y=713..757, strip between it and the status bar). */
function PaneFooter() {
  return (
    <>
      <Composer />
      <div className="git-strip-placeholder">git strip — deferred, not MVP</div>
    </>
  );
}

/** 33 px status bar (window-shell decision 5). Left: account row (local
 * config). Right: controls cluster — the model/thinking switcher's live
 * labels + the isTerminal-driven spinner. */
function StatusBar() {
  const { streaming } = useOmpStream();
  return (
    <div className="statusbar">
      <span className="statusbar-account">Jay · Gateway ⌄</span>
      <div className="statusbar-controls">
        <SwitcherCluster />
        {streaming && (
          <span className="model-spinner" role="status" aria-label="Agent running" />
        )}
      </div>
    </div>
  );
}
