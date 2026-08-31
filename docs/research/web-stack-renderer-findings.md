# Renderer-stack research findings

Context: React + TypeScript renderer for a desktop AI-chat client. Transcript = virtualized list, tens of thousands of rows, dynamic row heights (markdown messages, collapsible tool calls), streams at 60 fps with stick-to-bottom behavior (pinned to bottom while streaming, unpins when user scrolls up, 4 px slack band). Markdown = GFM + syntax-highlighted code blocks; while streaming, only the tail message changes, so rendering must be incremental (memoize completed blocks, re-render only the growing tail). Style: GitHub- and primary-source-only.

Weekly downloads (npm, 2026-08-23 → 2026-08-29, fetched via `https://api.npmjs.org/downloads/point/last-week/<pkg>`):

| package | weekly downloads |
|---|---|
| `@tanstack/react-virtual` | 23,240,523 |
| `react-markdown` | 33,678,442 |
| `shiki` | 23,738,330 |
| `streamdown` | 6,546,104 |
| `react-virtuoso` | 3,458,448 |
| `virtua` | 1,052,834 |

---

## 1. Virtual list — `@tanstack/react-virtual` (with `anchorTo: 'end'` + `followOnAppend`)

### Candidates

**react-virtuoso** — `followOutput` + `atBottomThreshold` (default `4` px slack band, configurable) + `alignToBottom`, dynamic-item-size with measurement built in. `atBottomStateChange` callback. MIT. Repo: 6.5 k stars, 1,031 commits, last-release activity present. [https://github.com/petyosi/react-virtuoso](https://github.com/petyosi/react-virtuoso), [https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/#followoutput-followoutput](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/#followoutput-followoutput), [https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/#atbottomthreshold-number](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/#atbottomthreshold-number). The proprietary `VirtuosoMessageList` (separate EULA, [https://virtuoso.dev/message-list-eula](https://virtuoso.dev/message-list-eula)) is the more featureful chat component, but free `react-virtuoso`'s `followOutput` is enough for this workload.

**@tanstack/virtual** — headless. Recent first-class chat primitives:
- `anchorTo: 'end'` — keeps the visible item stable on prepend and keeps an end-pinned viewport pinned when the last item grows during streaming. Default is `'start'`. [https://tanstack.com/virtual/latest/docs/api/virtualizer#anchorto](https://tanstack.com/virtual/latest/docs/api/virtualizer#anchorto)
- `followOnAppend: boolean | 'auto' | 'smooth' | 'instant'` — controls whether the virtualizer scrolls to the end after appends. The follow only happens if the viewport was already at the end before the append (so users who have scrolled up to read history are not pulled down). [https://tanstack.com/virtual/latest/docs/api/virtualizer#followonappend](https://tanstack.com/virtual/latest/docs/api/virtualizer#followonappend)
- `scrollEndThreshold: number` (default `1`) — pixel threshold used by `isAtEnd()` and `followOnAppend` to decide whether the viewport is close enough to the end to count as pinned. [https://tanstack.com/virtual/latest/docs/api/virtualizer#scrollendthreshold](https://tanstack.com/virtual/latest/docs/api/virtualizer#scrollendthreshold)
- `directDomUpdates: true` — avoid the React reconciler on the streaming tail.
- `shouldAdjustScrollPositionOnItemSizeChange` — per-item delta hook. [https://tanstack.com/virtual/latest/docs/api/virtualizer#shouldadjustscrollpositiononitemsizechange](https://tanstack.com/virtual/latest/docs/api/virtualizer#shouldadjustscrollpositiononitemsizechange)

Official `examples/react/chat` ships the exact pattern this workload needs: `prependHistory` (older messages above), `appendMessage` (new user messages below), `streamReply` (chunked streaming tail), `anchorTo: 'end'`, `followOnAppend: true`, `scrollEndThreshold: 80`, `getItemKey` keyed off message id, `useLayoutEffect` for initial scrollToEnd. [https://github.com/TanStack/virtual/tree/main/examples/react/chat](https://github.com/TanStack/virtual/tree/main/examples/react/chat), [https://tanstack.com/virtual/latest/docs/chat](https://tanstack.com/virtual/latest/docs/chat).

**virtua** (inokawa) — reverse scroll built in, iOS Safari support, ~3 kB gz per component. iOS Safari reverse-scroll has a known caveat ("user must release scroll") — [https://github.com/inokawa/virtua/issues/473](https://github.com/inokawa/virtua/issues/473). No first-party chat demo of the `anchorTo/followOnAppend` form; the chat scenario is documented but you'd write the stick-to-bottom glue yourself. [https://github.com/inokawa/virtua](https://github.com/inokawa/virtua).

### Streaming-jitter / known-issue evidence

- react-virtuoso has a documented iOS Safari glitch on scroll-up to items of unknown height (issue #945). Grid jitter/flickering (#1086) for dynamic-height grids below their content height. [https://github.com/petyosi/react-virtuoso/issues/945](https://github.com/petyosi/react-virtuoso/issues/945), [https://github.com/petyosi/react-virtuoso/issues/1086](https://github.com/petyosi/react-virtuoso/issues/1086).
- virtua's own README lists reverse-scroll glitches for the other libs in the comparison table and is upfront that its iOS reverse-scroll needs the user to release scroll.
- TanStack Virtual's chat guide documents the exact streaming-tall-tail contract: "Streaming chat responses usually grow the last item many times. In end-anchored mode, if the viewport is pinned to the end before the measured size changes, the virtualizer adjusts by the size delta and keeps the bottom stuck to the latest output." — they have a regression-tested story for this case. [https://tanstack.com/virtual/latest/docs/chat#keep-streaming-output-pinned](https://tanstack.com/virtual/latest/docs/chat#keep-streaming-output-pinned)

### What real chat UIs use

react-virtuoso's `VirtuosoMessageList` is what `virtuoso.dev/message-list/examples/ai-chatbot` ships as the reference. The TanStack repo ships a chat example. (Streamdown's docs page demos run on top of `useChat` from the AI SDK — they don't lock you to one virtualizer.)

### Recommendation

**`@tanstack/react-virtual` with `anchorTo: 'end'`, `followOnAppend: true`, `scrollEndThreshold: 4`, `directDomUpdates: true`.** Headless, free, MIT, chat primitives natively (including the size-delta pinning that is the project's central perf claim). Avoids the iOS-Safari glitch + proprietary-message-list split that the react-virtuoso path leads to. Use the official `examples/react/chat` as the template.

Fallback: `react-virtuoso` if the team later wants `VirtuosoMessageList`'s imperative scroll modifiers. `virtua` is overkill-by-API for this and gives up the chat-specific anchors.

---

## 2. Streaming-friendly GFM markdown — `streamdown` with `@streamdown/code`

### Candidates

**streamdown** (Vercel, MIT, 5.6 k stars). Drop-in `react-markdown` replacement built for AI streaming. [https://github.com/vercel/streamdown](https://github.com/vercel/streamdown):
- Block-level memoization: "Only blocks with changed content are re-rendered. Unchanged blocks remain memoized, even if new blocks are added. Parsing is cached per block." [https://streamdown.ai/docs/memoization](https://streamdown.ai/docs/memoization)
- Unterminated-block parsing via [`remend`](https://www.npmjs.com/package/remend) so streaming Markdown with missing closing fences renders cleanly. [https://streamdown.ai/docs/termination](https://streamdown.ai/docs/termination)
- Component-level `React.memo`.
- `isAnimating` prop disables interactivity while streaming (matches "don't let the user copy incomplete code").
- Full GFM (tables, task lists, strikethrough, autolinks) via `remark-gfm`. [https://streamdown.ai/docs/gfm](https://streamdown.ai/docs/gfm)
- `rehype-harden` for safe rendering by default.
- Optional plugins: `@streamdown/code | mermaid | math | cjk`. Standard usage with the AI SDK:
  ```tsx
  import { Streamdown } from "streamdown";
  import { code } from "@streamdown/code";

  <Streamdown animated plugins={{ code }} isAnimating={status === 'streaming'}>
    {part.text}
  </Streamdown>
  ```

**react-markdown + custom memoization** (the canonical Vercel AI SDK pattern). AI SDK cookbook "Markdown chatbot with memoization" splits with `marked.lexer`, wraps each block in `React.memo`, keyed `${id}-block_${index}`, and uses the AI SDK `useChat` `throttle` option. This is the recipe streamdown productizes. [https://ai-sdk.dev/cookbook/next/markdown-chatbot-with-memoization](https://ai-sdk.dev/cookbook/next/markdown-chatbot-with-memoization). `react-markdown` itself: 15.9 k stars, MIT, remark/rehype plugin ecosystem. [https://github.com/remarkjs/react-markdown](https://github.com/remarkjs/react-markdown).

**marked + manual** — fastest lexer, but you give up the remark/rehype plugin ecosystem (math, footnote, mermaid, autolink).

**Incremental parsers** — for streaming Markdown, there is no well-maintained React-bound incremental parser that beats the `marked.lexer` block-split. Streamdown's approach (split into blocks once, memo per block, remend the unterminated block) is the de-facto pattern.

### Bundle / perf / GFM

- `react-markdown` weekly downloads: 33.7 M (largest React markdown lib).
- `streamdown` weekly downloads: 6.5 M and 5.6 k GH stars — established, actively maintained, Vercel-stewarded.
- GFM parity: streamdown explicitly lists tables ✅, task lists ✅, strikethrough ✅; full GFM via `remark-gfm`. `react-markdown` is "100% to CommonMark, 100% to GFM with a plugin" (`remark-gfm`).

### Recommendation

**`streamdown`** with the `code` plugin on. It is literally the memoized-block + remend + safe-by-default recipe the Vercel AI SDK cookbook describes, shipped as a one-line drop-in, with full GFM, the `isAnimating` flag that disables copy on the still-streaming block, and `rehype-harden` as a free security default. Use `react-markdown` directly only if a downstream requirement forces hand-rolled block memoization or a remark/rehype plugin that streamdown doesn't expose.

---

## 3. Syntax highlighting — `shiki` via `@streamdown/code`

### Candidates

**shiki** (via streamdown's `@streamdown/code` plugin or via `rehype-shiki`). VS Code–grade TextMate grammars + themes. Total async-chunked bundle `6.4 MB minified / 1.2 MB gzip` for all themes + langs — but **lazy-loaded per language**, so each block only downloads the grammar it needs. Fine-grained bundle API lets you ship only the languages you want. [https://shiki.style/](https://shiki.style/), [https://shiki.style/guide/bundles](https://shiki.style/guide/bundles), [https://shiki.style/guide/install#fine-grained-bundle](https://shiki.style/guide/install#fine-grained-bundle).

The official perf guide is explicit:
- Cache the `highlighter` instance as a singleton. [https://shiki.style/guide/best-performance#cache-the-highlighter-instance](https://shiki.style/guide/best-performance#cache-the-highlighter-instance)
- Use shorthands for lazy async loading (instead of `createHighlighter` / `createHighlighterCore` loading everything upfront). [https://shiki.style/guide/best-performance#use-shorthands](https://shiki.style/guide/best-performance#use-shorthands)
- Offload to a worker for CPU-heavy streams. [https://shiki.style/guide/best-performance#use-workers](https://shiki.style/guide/best-performance#use-workers)
- `dispose()` when done (it can't be GC-ed automatically).

Streamdown's `code` plugin implements streamdown's `CodeHighlighterPlugin` interface around shiki and exposes `shikiTheme={["github-light", "github-dark"]}` dual themes.

**highlight.js / lowlight** (via `rehype-highlight`). Smaller (37 common languages bundled by default; ~190 with `all`), "pretty fast, relatively small, quite good." Trades VS Code–grade fidelity for size. [https://github.com/rehypejs/rehype-highlight](https://github.com/rehypejs/rehype-highlight).

**prismjs** — old, theme/grammar fragmentation, weaker modern maintenance. Not a serious contender for new work.

### "Highlight lazily, don't re-highlight the tail every frame" — verified pattern

Streamdown's documented behavior: "Code block shells render immediately with plain text content, then syntax colors are applied when highlighting resolves." This is the lazy-on-complete pattern, and it composes with streamdown's block-level memoization (the closed code block is a frozen React subtree, so the per-frame streaming cost is restricted to the growing tail). [https://github.com/vercel/streamdown](https://github.com/vercel/streamdown) (Code Blocks → Loading Behavior).

`rehype-shiki` can be wrapped in the same lazy pattern, but you'd be rebuilding streamdown's `code` plugin by hand.

Shiki's per-call cost for the highlighter instance is documented as expensive to create; the recommended pattern is singleton + worker.

### Recommendation

**`shiki` via `@streamdown/code`**. Lazy-on-complete (block shell renders first, colors resolve async), singleton highlighter, worker-friendly API, 200+ grammars with VS Code–grade fidelity — and already wired through streamdown's memoized-block pipeline so the growing tail doesn't re-highlight closed blocks. If bundle is a hard ceiling, swap to `rehype-highlight` (lowlight) — same lazy-on-complete pattern is implementable, smaller surface, but visibly lower-fidelity highlighting.

---

## 4. Anything clearly better than React for this workload

Default: **React stays.** The workload (virtual list + streaming markdown + shiki) is a solved problem in the React ecosystem — TanStack Virtual's chat primitives, streamdown's block memoization + remend, and shiki's worker-friendly highlighter are each first-class and co-maintained by the same Vercel/TanStack communities. Three mature libraries beat one hand-rolled Solid/Svelte stack at this scale, and the React Native / Tauri render path this codebase uses elsewhere (per `ompweb`) keeps React on the table for cross-platform reuse.

Solid/Svelte would only earn consideration if the team's measured per-flush React cost (with streamdown + TanStack Virtual + shiki) lands above the 16 ms frame budget on the target Windows hardware — at which point the Solid signal-fine-grained model is a known escape hatch. There's no evidence-backed reason to switch up front.

---

## TL;DR per question

1. **Virtual list** — `@tanstack/react-virtual` with `anchorTo: 'end'` + `followOnAppend: true` + `scrollEndThreshold: 4` + `directDomUpdates: true`. Stick-to-bottom is built-in, not hand-rolled.
2. **Markdown** — `streamdown` with `@streamdown/code`. Block-level memo + remend + safe-by-default is exactly the Vercel AI SDK recipe, shipped.
3. **Syntax highlighting** — `shiki` (via `@streamdown/code`), singleton highlighter + per-language lazy chunk. Lazy-on-complete pattern already wired.
4. **React vs alternatives** — React stays. No evidence-backed reason to switch.

---

## Source URLs (all primary)

Virtual list:
- https://github.com/petyosi/react-virtuoso
- https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/
- https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/#followoutput-followoutput
- https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/#atbottomthreshold-number
- https://virtuoso.dev/message-list-eula
- https://github.com/petyosi/react-virtuoso/issues/945
- https://github.com/petyosi/react-virtuoso/issues/1086
- https://github.com/inokawa/virtua
- https://github.com/inokawa/virtua/issues/473
- https://tanstack.com/virtual/latest
- https://tanstack.com/virtual/latest/docs/chat
- https://tanstack.com/virtual/latest/docs/chat#keep-streaming-output-pinned
- https://tanstack.com/virtual/latest/docs/api/virtualizer#anchorto
- https://tanstack.com/virtual/latest/docs/api/virtualizer#followonappend
- https://tanstack.com/virtual/latest/docs/api/virtualizer#scrollendthreshold
- https://tanstack.com/virtual/latest/docs/api/virtualizer#shouldadjustscrollpositiononitemsizechange
- https://github.com/TanStack/virtual/tree/main/examples/react/chat

Markdown:
- https://github.com/vercel/streamdown
- https://streamdown.ai/
- https://streamdown.ai/docs/memoization
- https://streamdown.ai/docs/termination
- https://streamdown.ai/docs/gfm
- https://streamdown.ai/docs/code-blocks
- https://ai-sdk.dev/cookbook/next/markdown-chatbot-with-memoization
- https://github.com/remarkjs/react-markdown

Syntax highlight:
- https://shiki.style/
- https://shiki.style/guide/install
- https://shiki.style/guide/bundles
- https://shiki.style/guide/best-performance
- https://github.com/rehypejs/rehype-highlight
- https://github.com/wooorm/lowlight

npm registry:
- https://api.npmjs.org/downloads/point/last-week/@tanstack/react-virtual
- https://api.npmjs.org/downloads/point/last-week/react-markdown
- https://api.npmjs.org/downloads/point/last-week/shiki
- https://api.npmjs.org/downloads/point/last-week/streamdown
- https://api.npmjs.org/downloads/point/last-week/react-virtuoso
- https://api.npmjs.org/downloads/point/last-week/virtua
