# Model and thinking-level switcher — ticket 09

Resolves issue #3. Companion to ticket 06's static status bar
(`crates/claude-omp-desktop/src/shell.rs: status_bar`) — 06 painted the
control cluster as labels; 09 specifies how they become interactive.

Reference designs (authoritative; if this spec contradicts them, fix the
spec):

- `Claude Code Images/Chat Input/model picker.png` — popover opened from
  the model label. Header `Models` (muted). Ten single-line rows.
  The first nine rows carry right-aligned numeric hotkeys `1`–`9`
  (muted); the current model (`GPT Terra - Sonnet`, matching the
  status-bar label below it) carries a blue checkmark instead of a
  number. No search field, no footer, no provider grouping.
- `Claude Code Images/Chat Input/thinking picker.png` — popover opened
  from the effort label. Title `Effort High` (`Effort` bold, level
  regular), `?` help icon top-right, `Faster` / `Smarter` end labels,
  and a detented slider with the filled track left of the handle.

## 0. Scope and verdict

The trigger cluster (`Bypass permissions · + · <model> · <effort> · ●`)
is specified in `docs/window-shell.md` decision 5; this ticket owns the
two right-most text elements. Clicking the model label opens the model
picker; clicking the effort label opens the thinking picker. Both
popovers anchor to the status-bar right cluster and drop **upward**
(the bar is at the bottom of the window; both screenshots show the
popover above its trigger).

This ticket ships:

1. This spec.
2. `crates/claude-omp-desktop/src/panel/switcher.rs` — `ModelPicker`
   and `ThinkingPicker`, the `get_available_models` cache, the
   `set_model` optimistic-update/reconcile state, and the status-bar
   inline-notice channel.
3. `tests/switcher.rs` — the assertions in §8, headless.

Explicitly **not** shipped:

- Fast-mode toggle UI (§6 — deferred with the data shape recorded).
- Login/auth UI (§7 — providers are configured via the `omp` CLI).
- Per-session model display in the sidebar (§5 — no session-list RPC).
- `cycle_model` / `cycle_thinking_level` bindings (§3.3 — headless
  conveniences, no UI affordance in the reference).

## 1. Data binding — the asymmetry between model and thinking

Both labels render RPC state; the reconciliation paths differ in kind,
which is why the two pickers do not share an update path.

| | Model | Thinking |
|---|---|---|
| Set command | `set_model {provider, modelId}` → `Model` on success | `set_thinking_level {level}` → no `data` |
| Self-sufficient event | `config_update.model` (`rpc-events.md` §1.5) | `thinking_level_changed {thinkingLevel, configured?, resolved?}` (§1.4) |
| Signal-only event | `model_changed {}` — **no payload**, must re-`get_state` | none needed |
| Documented failure | `error: "Model not found: provider/model"` (`rpc.md:778`) | none documented |
| Optimistic update? | **Yes** — paint on click, revert on failure, reconcile on `config_update`/`get_state` | **No** — label follows `thinking_level_changed`, never the click |

Reasoning. `thinking_level_changed` arrives on success carrying the
authoritative value, so painting early buys nothing and can flash wrong
on rejection. The model path is the opposite: `model_changed` is a
payload-free signal, the truth only arrives after a `get_state`
round-trip, and an optimistic paint bridges that gap. This asymmetry is
called out in `rpc-events.md` §1.4 and is the load-bearing design fact
of the ticket.

## 2. Model picker

### 2.1 Geometry and content (from the reference)

- Popover above the trigger, right-aligned to the cluster. White
  surface, 10 px radius, 1 px `border`, drop shadow.
- Header row `Models`, `text_muted`, 12 px.
- Single-line rows: the model's **`name`** field from the omp
  `Model` interface (`packages/catalog/src/types.ts:1004`). Provider
  names are deliberately not shown in MVP; the picker is the catalog
  in the order the server returns it. Variants that differ only by
  context window render the suffix dimmed (`1M` on the long-context
  variants in the reference).
- Right-aligned affordance per row: numeric hotkey `1`–`9`
  (`text_muted`) for the first nine rows; the current model shows an
  `accent` checkmark instead. Rows past the ninth show nothing.
- Hotkeys work while the popover is open: pressing `4` commits row 4.
  `↑`/`↓` move a highlight, `Enter` commits, `Esc` closes. Highlight
  starts on the current model.

### 2.2 Which models appear — the 60-provider question

The reference shows ten rows, not omp's full catalog. The popover
renders the list returned by `get_available_models` **in server order,
untruncated, in a scrollable list capped at ~10 visible rows** (the
reference height). omp's catalog for a configured user is the
provider/model set they have credentials for, which is what the
numbered shortlist in the screenshot is.

No search field and no provider grouping — the reference has neither.
If a real configured instance returns a list long enough that
scrolling hurts, add a search field then, matching on substring of the
display name.
<!-- ponytail: flat scroll list; search field only when a real catalog proves too long. -->

Catalog fetch: `get_available_models` once on session start; refetched
each time the popover opens (the catalog can change when the user runs
`omp login` in a terminal mid-session). Cache is shared across
sessions. Fetch failure: popover does not open; inline notice
`Models unavailable · click to retry` in the cluster.

### 2.3 Click path — optimistic update, then reconcile

1. Click (or hotkey) commits an entry; the popover closes.
2. The status-bar label paints the new display name immediately and the
   previous selection is stored in `pending_model`.
3. `set_model {provider, modelId}` goes out with a fresh `id`.
4. Response `success: true` → clear `pending_model`; done.
   Response `success: false` → revert the label to the stored previous
   selection, show the `error` string in the cluster inline notice for
   6 s.
5. `config_update {model, thinkingLevel}` at any time → the event wins:
   overwrite the label, clear `pending_model`.
6. `model_changed {}` at any time → send `get_state`; its `model` field
   overwrites the label and clears `pending_model`.

The label is never empty. The display name comes from `Model.name`
(catalog type, `packages/catalog/src/types.ts:1004`) and is always
present on a returned model — no fallback to `provider/modelId` needed.

### 2.4 Failure UX

| Failure | Surface |
|---|---|
| `set_model` → `"Model not found: provider/model"` | Inline cluster notice, 6 s; label reverts |
| `get_available_models` fails | Notice `Models unavailable · click to retry`; popover stays closed |
| RPC child dead (synthesized `agent_end`, see CLAUDE.md) | Both labels render dimmed; clicks are no-ops |

Note: omp's `getAvailableModels()` (`model-controls.ts:483`) returns
**models with valid API keys only** — providers without credentials
never appear in the catalog, so "missing credentials" is not a runtime
failure path in the picker. Login remains out of scope (§7) but is no
longer something the picker has to handle.

## 3. Thinking-level picker

### 3.1 Level set (from the omp RPC docs)

`rpc.md:251` / `rpc-events.md` §4:

```
off | minimal | low | medium | high | xhigh | max
```

Seven discrete levels → a slider with seven detents. `Faster` sits at
`off`, `Smarter` at `max`. The filled track runs from the left end to
the handle (reference shows this). The popover title renders
`Effort <Level>` with the level capitalized (`High`), updating live as
the handle moves between detents. The status-bar label shows the same
capitalized form. The `?` icon is a static tooltip explaining
faster-vs-smarter; no link, no page.

### 3.2 Commit path — event-driven, no optimistic paint

Releasing the handle on a detent (or clicking a detent) sends
`set_thinking_level {level}`. The popover stays open; the handle shows
a subtle busy state until `thinking_level_changed` arrives, then the
status-bar label updates **from the event payload** and the popover
closes. On `success: false` the handle snaps back to the current level
and the inline notice shows the error; the popover stays open.

`thinking_level_changed` carries `{thinkingLevel, configured?,
resolved?}`. Label rule: `resolved` when present, else `configured`,
else `thinkingLevel`.

### 3.3 Cycle commands are not bound

`cycle_thinking_level` (and `cycle_model`) exist for headless callers.
No UI affordance in the reference uses them; the pickers call the
explicit setters. If a keyboard shortcut for cycling is wanted later it
maps to the cycle commands directly since their responses carry the new
value.

## 4. Scope of a switch

`set_model` and `set_thinking_level` are **session-scoped**; whether
they persist beyond the session is omp's business (omp is authoritative
— CLAUDE.md), and the desktop client neither duplicates nor blocks that
write.

On `switch_session`, the labels re-read from the new session's
`get_state`. The model catalog cache survives the switch.

## 5. Sidebar display — out of scope

Showing each session's model in the sidebar needs a session-list data
source; RPC has no session-list command (ticket 03 finding), and the
sidebar's discovery layer doesn't parse session files for model info.
Deferred until a sidebar ticket wants it.

## 6. Fast mode — not in the MVP UI, data shape recorded

Decision: **no fast-mode control in MVP.** The reference cluster shows
no fast-mode affordance, and the state is genuinely two-valued —
`set_fast_mode` returns `{enabled, active}` which can disagree
(`enabled: false, active: true` under Fireworks provider priority;
`enabled: true, active: false` under the Anthropic sticky fallback —
`rpc.md:295-360`). A toggle that renders one boolean would lie in both
of those states.

Recorded for the future ticket that builds it:

- Read `fastModeEnabled` / `fastModeActive` from `get_state`.
- Honest rendering needs three states: active, wanted-but-inactive,
  off. A one-glyph chip in the cluster (between `Bypass permissions`
  and `+`) can do this with fill/outline/hidden.
- Enable on an unsupported model fails with the exact string
  `"Fast mode is unavailable for the current model."` — surface it
  verbatim in the inline-notice channel.
- Disable is idempotent but does not guarantee `active: false`.

## 7. Login — explicitly deferred

`get_login_providers` / `login` are RPC commands, but adding providers
is settings work, out of MVP scope (map: settings excluded). The MVP
assumes providers are configured via the `omp` CLI. Since the catalog
is pre-filtered by credentials (§2.4 note), the picker never has to
mention auth at all — a provider the user hasn't logged into simply
isn't listed.

## 8. Test plan

`tests/switcher.rs`, headless, mock transport in the shape of the
ticket-07 fixtures:

1. **Optimistic paint.** Commit a picker entry; assert the label shows
   the new display name before any response, and still does after
   `success: true`.
2. **Failure reverts.** Response `success: false, error: "Model not
   found: provider/model"`; assert label reverted and notice holds the
   exact error string.
3. **`config_update` wins.** With `pending_model` set, deliver a
   `config_update` naming a *different* model; assert the label follows
   the event and `pending_model` clears.
4. **`model_changed` re-arms.** Deliver `model_changed {}`; assert a
   `get_state` request went out, and the reply's model lands on the
   label.
5. **Thinking is event-driven.** Send `set_thinking_level {level:
   "high"}`; assert the label unchanged; deliver
   `thinking_level_changed {thinkingLevel: "high"}`; assert the label
   reads `High`. Also: payload with `configured: "high", resolved:
   "medium"` renders `Medium`.
6. **Hotkey commit.** With the popover open, key `3` commits row 3 and
   follows the same path as a click.

## 9. Prototype-time checks

Not spec blockers; verify during implementation:

- ~~The `Model` display-name field name and whether it can be absent~~ —
  resolved: `Model.name` (`packages/catalog/src/types.ts:1004`),
  always populated, no fallback needed.
- Real catalog length from a configured omp instance (drives whether
  §2.2's no-search decision holds).
- ~~The missing-credentials error string for §2.4~~ — resolved:
  no such failure path; `getAvailableModels()` filters by API key.

## 10. File changes

- **New** `crates/claude-omp-desktop/src/panel/switcher.rs` — both
  pickers' state (`SwitcherModel`), catalog cache, `pending_model`
  reconcile, inline-notice channel, and the screenshot fixture catalog.
- **Modified** `crates/claude-omp-desktop/src/panel/mod.rs` — exports.
- **Modified** `crates/claude-omp-desktop/src/shell.rs` — `status_bar`
  labels bound to `SwitcherModel`, `model_picker` / `thinking_picker`
  popovers mounted above the status bar. The prototype shell has no
  live RPC child, so commits run a synthetic immediate-success
  round-trip through the same state machine; the transport follow-up
  replaces the synthetic reply with the real one.
- **New** `crates/claude-omp-desktop/tests/switcher.rs` — §8, plus
  stale-response, mutual-exclusion, and level-set guards.

No changes to `omp-rpc`, the theme tokens, or `docs/window-shell.md`
(trigger geometry unchanged).
