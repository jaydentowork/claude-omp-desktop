// Composer slice (issue #23, window-shell decision 6): 44 px input box with
// placeholder + submit glyph in the pane-footer slot reserved by issue #20.
//
// Steer vs follow-up: `docs/rpc-events.md` §4.3 — the dedicated `steer` /
// `follow_up` commands need no `streamingBehavior` flag and cannot lose the
// local `isStreaming` race the way `prompt` can. While the agent streams,
// submit steers; otherwise it follows up. Interrupt (abort) is out of this
// slice — the streaming state is surfaced so a later ticket can hang an
// interrupt affordance on it.

import { useState, type FormEvent } from 'react';
import { useOmpStore, useOmpStream } from './omp-provider';

export function Composer() {
  const { streaming } = useOmpStream();
  const store = useOmpStore();
  const [text, setText] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (message === '') return;
    store.send?.({ type: streaming ? 'steer' : 'follow_up', message });
    setText('');
  };

  return (
    <form className="composer" data-streaming={streaming} onSubmit={submit}>
      <input
        className="composer-input"
        type="text"
        value={text}
        placeholder={streaming ? 'Steer the agent…' : 'Write a prompt…'}
        aria-label="Prompt"
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="submit"
        className="composer-submit"
        aria-label="Send prompt"
        disabled={text.trim() === ''}
      >
        ↑
      </button>
    </form>
  );
}
