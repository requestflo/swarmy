# Dashboard redesign — command bar + canvas (planes, not a sidenav)

Status: in progress. Core shell + Applications/Infrastructure planes shipped
(commit `feat(app): redesign shell`). This doc anchors the remaining page work.

## The shift

The dashboard moves from a 15-item navy sidenav to a **command-bar + full-canvas**
model, organised around **two planes** that mirror how operators actually think:

- **Applications** (`/`) — *what you deploy*. A Railway-style canvas of services as
  draggable cards (drag = visual only, positions persist per-org). Each card shows
  status, replica health, and a **placement badge** ("where does this run").
- **Infrastructure** (`/nodes`) — *what you deploy onto*. The cluster: live KPIs +
  utilisation trend + a grid of node cards.

Everything else is reachable from the **⌘K command palette** (primary navigator)
and the command bar's **More** overflow, grouped via `@/lib/destinations.ts`
(Deploy · Networking · Delivery · Data · Observability · Settings).

## Why two planes (user's framing)

"The infrastructure vs the application stack deployment" are two separate things.
Node placement is shown as a *badge on each app card* + surfaced on the
Infrastructure plane — not as canvas-filtering tabs. Dragging never changes where
containers run (visual only); placement stays a deliberate action.

## Shell anatomy (built)

- `components/shell/command-bar.tsx` — wordmark + org + cluster pulse · plane tabs ·
  ⌘K search · `SectionsMenu` overflow · one coral **Deploy** CTA · `UserMenu`.
- `components/shell/command-palette*.tsx` — global ⌘K, groups: Actions, Planes,
  sections, live Services, live Nodes.
- `components/shell/mobile-chrome.tsx` — compact header (wordmark + search + avatar)
  + bottom bar (Apps · Infra · centre Deploy FAB · Search · Settings).
- `components/shell/plane-tabs.tsx` — Applications/Infrastructure segmented control.
- `lib/destinations.ts` — single registry for all nav. Add a page here once.

## Canvas (built)

`components/canvas/*` — `applications-canvas` (React Flow orchestrator),
`service-node` (card), `build-graph` (pure layout), `use-canvas-layout` (persist),
`canvas-toolbar`, `service-detail-sheet`, `canvas-empty`. Backend: `CanvasLayout`
model + `canvas` tRPC router (`get`/`save`).

## Remaining page conventions (Phase 4)

Every other page stays a **document page** under the floating bar. Rules:

1. Container: `mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10` (focus
   forms narrower: `max-w-3xl`). No sidenav offset (`lg:pl-64` is gone).
2. Hot Signal anatomy: `PageHeader` (eyebrow + headline with coral `<em>` +
   description + one coral CTA in `actions`). Lists = flat rows in one `card-pop`
   divided by hairlines, never per-row cards (node grid is the deliberate
   exception). Status via `StatusBadge` + `--status-*` tokens. Numbers in mono.
3. Empty states sell the next action.
4. Preserve every tRPC query/mutation + `refetchInterval` exactly — restyle only.
5. Decompose per `react-components` limits (150-line routes; sub-components in
   `components/<feature>/`).
6. Wayfinding: pages reached via ⌘K/overflow; cross-links use typed `Link`.

### Page → plane/group

- Deploy: `/stacks`, `/services/new`, `/services/$serviceId`, `.../terminal`,
  `/services/builder`.
- Infrastructure: `/nodes/new`, `/nodes/$nodeId`, `.../terminal`.
- Networking: `/ingress`, `/networking`, `/geo`.
- Delivery: `/ci`, `/ci/$buildId`.
- Data: `/backups`, `/backups/schedules`, `/settings/backup`.
- Observability: `/observability`, `/observability/$traceId`.
- Settings: `/settings`, `/settings/access`, `/settings/api-keys`.
- Terminal: `/terminal/sessions/$id` (full-bleed player).
