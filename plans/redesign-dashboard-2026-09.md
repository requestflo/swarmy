# Dashboard redesign 2026-09 — a calm ops console for novices and experts

Status: **proposal, awaiting owner review. No code changed.**
Supersedes `plans/redesign-command-canvas.md` (its command-bar/two-plane shell
was already replaced by the sidenav; its per-page conventions are folded in
here). Keeps `docs/product/product-shape.md`'s estate/stack split intact.

Evidence: 18 screenshots of the live demo at 1440w (scratchpad `ux-shots/`),
plus a code pass over `lib/destinations.ts`, `lib/stack-nav.ts`, the routes
tree, `components/overview/*`, `components/canvas/*`, `demo/resolvers/*`.

## A. Principles

1. **Novice-first defaults, expert depth one click away.** Every screen works
   with zero configuration. Anything a novice never needs (drivers, Caddyfile
   previews, management URLs, ABAC JSON) lives behind an `Advanced` disclosure
   or a raw-view toggle, never on the first paint.
2. **One source of truth per number.** A metric is computed once (one hook,
   one query) and rendered everywhere from that value. The sidenav footer, the
   KPI card and the "Needs attention" list can never disagree.
3. **Calm ops console, not a marketing site.** Type says what the screen *is*;
   status says what needs *doing*. The hero headline is retired from every
   page except Overview. Coral marks the one thing to do next.
4. **Never show a fake zero.** Unknown is a skeleton; zero is a fact. First paint
   always draws the page frame.
5. **One word per concept.** App / Service / Server / Domain (see B.3).
6. **Everything "already on" is stated in one line, not a chore.** Backups,
   TLS, alerts and the mesh ship enabled; the UI says so and offers *change*,
   not *set up*.

## B. Information architecture

### B.1 The new nav (desktop sidenav, mobile tab bar)

Seven flat rows. Grouping follows what a user is doing, not what subsystem
owns it.

| Row | Route | Contains (in-page tabs) | Badge |
|---|---|---|---|
| **Overview** | `/overview` | Estate summary, attention list, get-started (empty estate only) | — |
| **Apps** | `/` | App list → app workspace (`/stacks/$name`) | apps degraded |
| **Servers** | `/nodes` | Server list · **Add server** · Regions/globe (advanced) | servers offline |
| **Network** | `/network` | Domains (all apps) · Edge · Mesh · Geo-DNS | edge unhealthy |
| **Data** | `/data` | Object storage · Backups (destinations + estate schedule + controller backup) · AI gateway | backup failed |
| **Activity** | `/activity` | Alerts · Incidents · Audit log · Cost | alerts firing + incidents open |
| **Settings** | `/settings` | Workspace · Members & access (roles, SSO, guardrails, exposure) · API & Terraform · Notifications · CI & registry | — |

Deploy is a **verb, not a place**: the coral `Create` button and ⌘K own
"Deploy an app" (blueprint / compose / image). `/blueprints` becomes the
first step of the deploy flow, not a nav destination.

### B.2 Old route → new home

| Old | New |
|---|---|
| `/overview`, `/`, `/nodes*` | unchanged |
| `/blueprints` | `/deploy` (step 1 of the deploy wizard) |
| `/ci`, `/ci/$buildId` | `/settings/ci` (+ per-app Releases tab keeps the build log) |
| `/ingress` (Edge & ingress) | `/network/edge` |
| `/networking` (Mesh) | `/network/mesh` |
| stack `Network` tab, `/geo*` | app `Domains` tab; estate-wide list at `/network/domains`; geo at `/network/geo` |
| `/data/buckets` | `/data/storage` |
| `/backups`, `/settings/backup` | `/data/backups` (destinations · schedule · controller backup as one page with sections) |
| `/ai` | `/data/ai` |
| `/alerts`, `/incidents`, `/audit`, `/cost` | `/activity/{alerts,incidents,audit,cost}` |
| `/governance`, `/exposure`, `/settings/access` | `/settings/access` (Members · Roles & policies · Guardrails · Exposure as sections) |
| `/settings` General→{General, Members, Join tokens} | `/settings` (workspace) · members → `/settings/access` · join tokens → **deleted**, live only inside Add server (advanced: "mint a raw token") |
| `/settings/api-keys`, `/settings/notifications` | `/settings/api`, `/settings/notifications` |
| 18 redirect stubs (`/webhooks`, `/workflows`, `/data*`, `/observability`, `/backups/schedules`, `/jobs`, `/configs`, `/status-pages`, `/releases`, `/geo*`, `/queues`, `/resilience`, `/stacks` index, `/secrets`) | **delete**; one catch-all `_authed/$.tsx` → `/overview` with a toast "That page moved." |

Stack workspace tabs stay, renamed: Overview · Services (the canvas, default)
· Domains · Data · Messaging · Observability · Config · Backups · Releases ·
Settings. Only `Network → Domains` changes.

### B.3 Terminology (apply everywhere: UI copy, `destinations.ts`, palette, toasts)

| Concept | Word | Never |
|---|---|---|
| A compose stack / blueprint deployment | **App** | stack (UI copy; routes keep `/stacks` for API stability) |
| One container spec inside an app | **Service** | app, workload, container |
| A machine in the swarm | **Server** | node (UI copy only; `nodes` router/routes unchanged) |
| A hostname pointing at a service | **Domain** | route, ingress, host |
| The proxy fleet | **Edge** | ingress driver (only inside Advanced) |
| Private network | **Mesh** | overlay, WireGuard (only inside Advanced) |

CTAs: "Deploy an app", "Add a service", "Add a server", "Add a domain".

## C. The novice golden path

Installer prints one URL. First login lands on Overview.

| # | Screen | What they see | One coral CTA |
|---|---|---|---|
| 1 | **Overview (empty estate)** | Ink block: "Your cloud is up. One server, ready." with server name, IP, HTTPS lock. Below: a 3-step rail — *Deploy an app* · *Add a domain* · *Add another server (optional)*. No KPI cards, no attention list. | Deploy an app |
| 2 | **Deploy — choose** (`/deploy`) | Three big tiles: **Blueprint** (gallery, default), **Compose file**, **Image**. Blueprint gallery is a searchable grid with a one-line "what you get" each. | Deploy WordPress |
| 3 | **Deploy — configure** | Name (prefilled), domain (prefilled `wp.<server-ip>.sslip.io` so HTTPS works with zero DNS), secrets auto-generated. `Advanced ▸` reveals replicas, placement, env, the raw compose. | Deploy |
| 4 | **Deploy — progress** (full-screen sheet) | Live step list: Pulling images → Creating services → Issuing certificate → Health check. Each with a `.pulse-dot`, elapsed mono time. Log stream behind `Show logs`. | — (Cancel ghost) |
| 5 | **Success moment** | "It's live." + the URL as a big copyable link + *Open ↗*. Three quiet lines: "Backed up nightly to this server's disk · Alerts on for downtime and disk · HTTPS renews itself." Each line is a link to *change*. | Open app |
| 6 | **App workspace** | Lands on Services canvas with the new app; a one-time coach mark on the Domains tab ("Point your own domain here when ready"). | — |
| 7 | **Overview (populated)** | KPIs, apps strip, attention list. Rail step 3 "Add another server" stays as a dismissible card until a second server exists. | Add a server |

Add-a-server (`/nodes/new`) keeps the existing one-liner flow but drops the
role picker and labels below `Advanced ▸`; default is Automatic. The
"waiting for the server to appear" state polls with a pulse, then celebrates.

"Already on" is implemented once: an `<AlreadyOnLine>` component reading a
single `estate.defaults` query (backups target present, alert channel present,
TLS mode) and rendering the same three lines on the success screen, on
Overview's empty-rail, and at the top of each app's Backups tab — replacing the
"storefront is covered" / "Nothing runs on a schedule yet" contradiction.

## D. Expert affordances

- **`Advanced ▸` disclosure**: one shared `<AdvancedSection>` (collapsed by
  default, remembers open state per section id in `localStorage`, shows a
  count of non-default values when collapsed: "Advanced · 2 changed"). Used
  per-section, never per-page.
- **Raw views**: every configured thing has a `Raw` toggle at the section
  corner — compose YAML (app), Caddyfile (edge), policy JSON (access), rendered
  labels (service). Read-only mono panel with copy; editing stays in the form
  except compose.
- **Compose editor**: CodeMirror 6 (yaml + lint gutter) replaces the textarea;
  diff view against the running spec on redeploy.
- **Command palette (⌘K)** becomes the expert navigator: actions, every page,
  every app/service/server, and *raw* jumps ("open Caddyfile"). Keyboard map:
  `⌘K` palette · `g o/a/s/n/d/v/,` go to Overview/Apps/Servers/Network/Data/Activity/Settings ·
  `c` create · `/` focus list filter · `j/k` move in lists · `enter` open ·
  `x` select row · `⇧A` advanced toggle · `?` show map. Registered in one
  `lib/keymap.ts`, surfaced by a `?` sheet.
- **Bulk actions**: list rows get a checkbox on hover/`x`; a bottom action
  bar appears (Servers: drain/label/remove · Services: scale/restart/redeploy ·
  Domains: enable/disable protection · Alerts: ack). One `<BulkBar>` component.
- **API / CLI / Terraform**: every list page header has an `API` chip that
  opens a side sheet with the equivalent `curl`, `swarmy` CLI and Terraform
  block for what's on screen. Backed by the existing `openapi.json`; no new
  server work.
- **Density toggle** (Comfortable / Compact) in the user menu; compact removes
  card padding and stacks KPIs in a strip.

## E. Visual system changes

| Area | Change |
|---|---|
| **Page header** | Retire the hero headline everywhere but Overview. New `<PageHeader>`: eyebrow row (breadcrumb, mono) · `h1` at `text-2xl/3xl` = the page name · optional status chip inline (`● 4/5 online`) · one coral CTA right. Section tabs sit directly under. Saves ~140px per page. Overview keeps one display headline but only with a truthful status word ("All green." / "2 things need you."). |
| **Stack header** | One header for all tabs: `← Apps / storefront` breadcrumb in the eyebrow, app name, status chip, tab strip. The canvas toolbar loses its duplicate breadcrumb pill. No header jump between tabs. |
| **Density** | KPI cards → one 4-up strip `h-20`; card padding `p-5`; list rows `h-14`. Stack canvas fits-to-view on load with `padding: 0.3`. |
| **Card patterns** | Three only: `Surface` (card-pop), `Stat` (mono number + label + tone), `Row` (flat hairline row in a Surface). Kill per-row cards. |
| **Status language** | One `StatusChip` with the five `--status-*` tones and fixed vocabulary: online · deploying · attention · offline · idle. Same words in nav badges, rows, KPIs. |
| **Shared states** | `<PageSkeleton variant="list|kpis|canvas|form">`, `<EmptyState icon title action>`, `<ErrorState retry>` in `components/states/`. Every route renders `PageSkeleton` while `isPending`; `CountUp` animates only on first *settled* value, never from a placeholder 0. |
| **Dark canvas chrome** | React-Flow `Controls`/`MiniMap` get token styling (`bg-card border-border`, `maskColor` from `--background`, node colours from status tones). Same for the Infrastructure canvas. |
| **Mobile** | Tab bar rows → Overview · Apps · `+` · Servers · Activity. Stack tabs become a horizontal scroller with fade edges. Forms single-column; bulk bar becomes a sheet. |

## F. Per-page jank list (confirmed)

| Page | Problem | Fix |
|---|---|---|
| Overview | KPIs 1/5 vs footer 4/5, alerts 0 vs 2 — separate queries (`dashboardSummary` vs `nodes.list` vs `alerts.overview`) **and** `CountUp` from 0 on every mount (shot 16 caught it mid-animation at 3/5) | `useEstateSummary()` hook (one query) feeds sidenav footer, KPIs, headline, attention card; CountUp on first settled value only |
| Overview | "Get set up" fully ticked but still rendered; headline "Something needs .you" (broken spacing from `replace()`) | Checklist hides when complete; headline built from parts, not string replace |
| First paint (all) | "0 of 0 nodes online", "You", "0/0" while loading; Stacks page blank | `PageSkeleton` per route; sidenav footer shows shimmer until settled |
| Stack canvas | White MiniMap + Controls on dark; canvas mostly empty; header differs between Overview tab and others | Token-styled chrome; `fitView` with padding; one `StackHeader` |
| Stacks list | "4 stacks discovered" hero; "All services" secondary link unclear | "Apps" header + status chip; "All services" becomes a list/canvas view toggle |
| New stack | Plain textarea; huge hero | CodeMirror; part of `/deploy` wizard |
| Infrastructure | Hero; "Collecting live samples…" chart empty in demo; globe far below fold | Compact header; chart skeleton with sample ETA; globe under `Advanced ▸ Regions` |
| Add node | Role + labels exposed up front | Automatic default, Advanced disclosure |
| Platform → Edge | Driver select, Caddyfile, ask-endpoint URL on first paint | Novice summary card ("HTTPS on, Caddy serving 4 domains on 2 servers") + Advanced sections + Raw view |
| Platform → Mesh | Management URL / service token on first paint; "Enroll a node" duplicates Add server | Summary card ("4 servers meshed, managed by swarmy"); enrol happens automatically in Add server; token fields under Advanced |
| Stack → Network | "Domains & routes", "1/3 secured" ambiguous; Geo-DNS list repeats domains | Rename tab Domains; one row per domain with TLS + geo columns |
| Governance | 370-line policies tab; block/warn selects + toggles dense | Moves to Settings → Access; rule rows as `Row` with a single tri-state chip |
| Alerts | Fine, but hero; "Rules" list has no bulk ack | Compact header; bulk ack |
| Settings | "Run the team." + "Enroll a node" CTA; tabs inside tabs | Sections, no nested tabs; join tokens removed |
| Stack → Backups | "storefront is covered" above "Nothing runs on a schedule yet" | `AlreadyOnLine` + a real schedule row (nightly default) |
| Global | 18 redirect stubs; only ⌘K shortcut; `recovery-claims-banner.tsx:34` raw `amber-500` | Catch-all route; keymap; token |
| Global | Copy drift: stack/app/service, node/server, "Deploy a service"/"Deploy from compose"/"Add app" | Glossary B.3 applied via a copy sweep |

## G. Phased build order

| Phase | Ships | Size | Touches |
|---|---|---|---|
| **P0 Correctness & jank** (independently shippable) | `useEstateSummary` single source; CountUp fix; `components/states/*` skeleton/empty/error + wire into every route; dark canvas chrome; one `StackHeader`; delete redirect stubs + catch-all; token fix; checklist hides when done | ~3 days | `lib/use-estate-summary.ts`, `components/overview/*`, `shell/sidenav.tsx`, `canvas/service-canvas.tsx`, `infrastructure/infra-canvas.tsx`, `routes/_authed/stacks/$name.tsx`, `canvas/canvas-toolbar.tsx`, 18 route files, `routeTree.gen.ts` |
| **P1 Shell, nav, IA, headers** | New `destinations.ts` (7 rows), `NAV_GROUPS` → sections, route moves with redirects kept one release, new `PageHeader`/`SectionHeader` (no hero), terminology sweep, mobile tab bar | ~5 days | `lib/destinations.ts`, `lib/stack-nav.ts`, `shell/*`, `page-header.tsx`, `section-header.tsx`, every route file's header, `demo/registry.ts` |
| **P2 Golden path** | Empty-estate Overview, `/deploy` wizard (blueprint/compose/image), progress sheet, success moment, `AlreadyOnLine`, Add server simplified, default nightly backup schedule surfaced | ~6 days | `components/deploy/*` (new), `components/onboarding/*`, `components/overview/*`, `blueprints/*`, `stacks/new`, `backups/stack-schedules-card.tsx`, demo resolvers for deploy progress |
| **P3 Expert layer** | `AdvancedSection`, Raw views, CodeMirror compose, keymap + `?` sheet, palette expansion, `BulkBar` on Servers/Services/Domains/Alerts, API chip sheet, density toggle | ~6 days | `components/advanced-section.tsx`, `lib/keymap.ts`, `shell/command-palette*`, `components/bulk-bar.tsx`, `components/api-sheet.tsx`, list pages |
| **P4 Page-by-page polish** | Edge/Mesh novice summaries; Access consolidation; Backups page merge; decompose >150-line components (`region-globe`, `policies-tab`, `swarm-on-mesh-card`, `swarm-health-card`, `offsite-mirror-card`); light-theme audit | ~5 days | `ingress/*`, `networking/*`, `access/*`, `backups/*`, `infrastructure/*` |

Each phase ends with `bun --filter @swarmy/app typecheck && build` and a
demo-mode walkthrough in both themes at 1440 and 390 wide.

## H. Risks and guards

- **REST / SDK / Terraform untouched.** Only `apps/app` changes; routers keep
  their names (`nodes`, `stacks`). UI word changes never rename an API field.
- **Demo resolvers must track new queries.** `useEstateSummary` and
  `estate.defaults` need demo resolvers in `demo/resolvers/core.ts`; the
  deploy-progress sheet needs a scripted demo timeline. Add a CI check that
  every tRPC path used in `apps/app` has a demo resolver entry.
- **e2e**: `apps/e2e/tests/smoke.spec.ts` targets the marketing site only; the
  app has **no `data-testid`s today**. P1 adds `data-testid` on nav rows, the
  Create button, and the deploy wizard steps so P2 can get a headline e2e
  (install → deploy → reachable) without selector churn.
- **Route moves break bookmarks.** Keep old paths as redirects for one release
  (a table in `lib/legacy-routes.ts`), then the catch-all.
- **Hot Signal skill drift.** `hot-signal-design/SKILL.md` still mandates the
  hero headline and 8-row nav; update the skill in P1 so future work follows
  the new anatomy.
- **Hero removal changes the brand feel.** Mitigated by keeping one bold
  statement on Overview and in the success moment, where a statement is
  earned.
