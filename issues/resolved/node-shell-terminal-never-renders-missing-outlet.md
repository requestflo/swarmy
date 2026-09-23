# "Node shell" (web terminal) silently does nothing — the parent node-detail route has no `<Outlet />`, so the nested terminal route can never mount

**Status:** Fixed in code (2026-09) — pending live re-verification. See "Fix applied" below.
**Severity:** Critical — "Node shell" is the platform's break-glass host-access feature ("A host shell
on the node itself — the highest-risk access. Gated, approved, and recorded.") and it is completely
unusable: the button does nothing visible at all, with no error, no console warning, no failed network
request — just silence.

## Symptom

Live reproduction via the real product UI, on `lima-swarmy-node-1`'s node detail page
(`/nodes/cmrfn07qd001e4vsb8mbv6prq`):

1. Clicked the "Node shell" button (top-right of the node detail page). The URL changed to
   `/nodes/cmrfn07qd001e4vsb8mbv6prq/terminal`, and network requests confirmed the terminal route's
   JS modules loaded successfully (`nodes/$nodeId.terminal.tsx`, `components/terminal/web-terminal.tsx`,
   both `200`).
2. **The rendered page did not change at all.** Two screenshots (immediately after the click, and
   again after a further wait) showed the identical node-detail page — "lima-swarmy-node-1 is
   degraded", the "Repair this node" panel, Live utilization chart, Details panel, Controls section —
   with no terminal window, modal, overlay, or any new element anywhere on screen.
3. Confirmed this isn't a client-side router staleness artifact: did a full hard navigation
   (`navigate` to the `/terminal` URL directly, forcing a fresh page load) and got the exact same
   result — same node-detail content rendered, URL correctly showing `/terminal`.
4. Checked console messages (all benign Vite HMR/DevTools noise, no errors) and network requests (the
   terminal route's own component module loads with a `200` — it is being fetched) — nothing indicates
   a failure. The bug is a pure silent no-op, not a crash.

## Root cause

TanStack Router's flat file-route naming treats a dot as nesting: `nodes/$nodeId.terminal.tsx` is a
**child route of** `nodes/$nodeId.tsx`, not a sibling. A parent route only ever renders its child by
including `<Outlet />` in its own component — otherwise the child route matches internally (routing,
loaders, and data-fetching all still happen) but has nowhere to render into, so the page visually never
changes.

- `apps/app/src/routes/_authed/nodes/$nodeId.tsx:14-77` (`NodeDetailPage`) renders `PageHeader`,
  `NodeRepairCard`, `NodeLivePanel`, `NodeDetailsPanel`, `NodeControlsPanel`, `NodeContainersPanel` —
  and **no `<Outlet />` anywhere**. Confirmed via `grep -rl "Outlet" apps/app/src/routes/_authed/` — this
  file is absent from the results.
- `apps/app/src/routes/_authed/nodes/$nodeId.terminal.tsx:17-153` (`NodeTerminalPage`) is a fully-built
  page — `PageHeader` with eyebrow "Node shell", an "Open node shell" button, a recording-notice
  `Alert`, and a `WebTerminal` component wired to a `wsUrl` once opened. This component is never given
  a chance to mount; it is dead code from the user's perspective.
- Confirmed registered correctly in the router: `apps/app/src/routeTree.gen.ts:412-413` shows
  `AuthedNodesNodeIdTerminalRoute` is generated and present in the route map — this is not a
  route-registration failure, purely a missing-outlet rendering failure.

The same codebase already has two different, both-correct ways to solve exactly this problem, and the
node-detail page uses neither:

1. **Escape nesting entirely** — `apps/app/src/routes/_authed/services/$serviceId_.terminal.tsx`
   (note the trailing `_` immediately after `$serviceId`) uses TanStack Router's documented
   "opt out of layout nesting" filename convention, making the service-terminal page a flat,
   independent route rather than a child of `services/$serviceId.tsx`. This works correctly — the
   service terminal page is a real candidate to confirm whether the same underscore fix would apply
   here (not yet tested, see below).
2. **Actually render the Outlet** — `apps/app/src/routes/_authed/stacks/$name.tsx:2,18` correctly
   `import { ... Outlet } from '@tanstack/react-router'` and renders `<Outlet />`, making it a real
   layout for its own nested children (`$name.backups.tsx`, `$name.config.tsx`, `$name.data.tsx`,
   `$name.messaging.tsx`, `$name.network.tsx`, `$name.observability.tsx`, `$name.releases.tsx`,
   `$name.settings.tsx`, `$name.index.tsx`) — confirmed this is the intended pattern for tabbed detail
   pages with multiple sub-views sharing a shell.

`nodes/$nodeId.tsx` was written as a leaf-style full-page component (like a route with no children was
expected), but `nodes/$nodeId.terminal.tsx` was later added as a nested dotted file without either
opting out of nesting or adding the required `<Outlet />` to the parent — an integration gap between
two files that were evidently written without checking how they compose.

## Why this matters

Node shell is explicitly positioned as the highest-risk, most-gated access path in the product ("the
highest-risk access. Gated, approved, and recorded.") — exactly the kind of feature an operator reaches
for during an actual incident, when a node won't cooperate any other way. It fails completely silently:
no error toast, no console warning, no failed request — a user has no way to tell whether they
misclicked, whether the feature requires some permission they lack, or whether it's simply broken. This
also blocks testing of everything downstream of it (`TerminalPolicy.nodeShellEnabled`,
`SWARMY_ALLOW_NODE_SHELL`, the approval/recording flow, `WebTerminal`'s actual WebSocket session) since
the entry page can never be reached.

## Suggested fix direction

Either:
- Rename `apps/app/src/routes/_authed/nodes/$nodeId.terminal.tsx` to
  `apps/app/src/routes/_authed/nodes/$nodeId_.terminal.tsx` (trailing underscore after `$nodeId`,
  mirroring the already-working `services/$serviceId_.terminal.tsx` pattern) so it becomes a flat,
  non-nested route, **or**
- Add `<Outlet />` to `apps/app/src/routes/_authed/nodes/$nodeId.tsx` if node-detail is meant to grow
  more tabbed sub-views the way `stacks/$name.tsx` does (in which case the parent's own content likely
  also needs restructuring into a shared shell + tab nav, matching the stacks pattern, rather than a
  monolithic single view).

Given `$nodeId.tsx` currently renders full page content with no tab navigation and no other nested
children exist for nodes today, the underscore-escape fix is the smaller, more targeted change.

Add a regression test (or at minimum a route-tree smoke test) asserting every `createFileRoute` leaf
component that is nested under a nesting-implying dotted filename either has a parent with `<Outlet />`
or itself uses the trailing-underscore escape — this exact class of bug (a route matches, fetches, and
silently fails to render) would otherwise keep recurring as more nested routes get added.

## Not yet tested

Whether `services/$serviceId_.terminal.tsx` (the working sibling pattern) actually renders and connects
a live WebSocket session end-to-end — not attempted this pass, since this file is scoped to the node
shell specifically; worth a follow-up pass once this fix direction is confirmed, to validate the
`WebTerminal` component and `TerminalPolicy`/`SWARMY_ALLOW_NODE_SHELL` gating logic actually work once
the page can be reached at all. Also not tested: whether `terminal.sessions.$id.tsx` (a third
terminal-related route seen in network requests during this investigation) has the same or a different
nesting relationship to its parent.

## Fix applied (2026-09)

- Renamed `apps/app/src/routes/_authed/nodes/$nodeId.terminal.tsx` to `$nodeId_.terminal.tsx` (route id `/_authed/nodes/$nodeId_/terminal`), matching the `services/$serviceId_.terminal.tsx` opt-out-of-nesting idiom. URL path unchanged (`/nodes/$nodeId/terminal`), so existing links still work. Route tree regenerated.
