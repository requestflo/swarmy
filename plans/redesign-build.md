# Redesign build — the 68 boards, in Calm Layers

Status: **S0–S5 built, S6 verified** (branch `claude/swarmy-platform-roadmap-4f6qfm`, 2026-09-25).
Owner decision (2026-09-25): build the 68-board "swarmy dashboard redesign"
canvas with the **Calm Layers** structure. Same screens, same navy/coral look;
every screen reads at three depths.

Inputs: the canvas boards (`redesign-canvas-v2/frags/*.html`, published at
claude.ai/artifact/PS2nY46xC9r5Cj4gYtvf4y), the Calm Layers spec and R-boards
(`redesign-directions/RECOMMENDATION.md`, `CRITIQUE.md`, `frags/R*.html`),
Harbour polish (`redesign-styles/STYLES.md`, quieter surfaces only), and
`plans/redesign-dashboard-2026-09.md` (nav, vocabulary, phases).

## 1. The rules every screen follows

| Rule | What it means in code |
|---|---|
| Three depths | `summary` ⊂ `controls` ⊂ `code`. `<Depth at="controls">…</Depth>` shows its children from that depth up. Depth **adds** detail; it never moves or removes what a lower depth shows. |
| Summary | A sentence headline (`<SayHeader>`), a lede with the numbers, and **one** next action (`<NextAction>`). No glossary words (see §4). |
| Controls | The forms and knobs. Technical detail is inline as a mono `<Tech>` line, never behind an `Advanced ▸`. |
| Code | `<CodeView>`: the exact swarmy.yaml / CLI / REST for what is on screen, with a source note: "Lives in swarmy.yaml · saving opens a PR" or "Dashboard setting · same call over REST". |
| Per-person default | The sidenav "Show me" dial sets the person's default (`localStorage` key `swarmy-depth:<userId>`, falling back to `swarmy-depth`). The top-bar switch changes only the current page; it resets to the default on navigation. A `<Section switchable>` can switch itself. |
| One coral action | Per screen, one `variant="default"` (coral) button: the next action. Everything else is outline/ghost. The sidenav "Deploy an app" is the shell's, not the page's. |
| Never a fake zero | Pending → `PageSkeleton`/`CardSkeleton`; a number shows only once settled (unchanged from P0). |

Retired: `Advanced ▸` disclosures, `Raw` toggles and hero headlines on
non-Overview pages. They become depth.

## 2. Shared component set (`apps/app/src/components/calm/`)

| Component | Board source | Role |
|---|---|---|
| `DepthProvider`, `useDepth`, `useDepthDefault`, `<Depth at>` (`depth.tsx`) | `rnav` dial, `dseg` | Per-person default + per-page override + per-section override. |
| `DepthDial` (`depth-dial.tsx`) | `.rdial` | "Show me: Summary · Controls · Code" in the sidenav (sets the default). |
| `DepthSwitch` (`depth-dial.tsx`) | `.dseg` | Top-bar switch for this page (and inside a switchable section). |
| `CalmPage` (`calm-page.tsx`) | `.rtop` + body | Top bar (mono breadcrumb + depth switch + optional quiet actions), body with `main` + optional `aside`. |
| `SayHeader` (`say-header.tsx`) | `.say` / `.lede` / eyebrow | Sentence headline; `<Say tone="warning">` colours the clause that matters, `<em>` renders as a quieter second clause. |
| `NextAction` (`next-action.tsx`) | `.next` | Coral-bordered card: what needs you, why it is safe, the one coral button, a `tech` line at Controls. |
| `Section` (`section.tsx`) | `.sect` | Quiet card with an `h2`, count, a mono "→" link, optional own depth switch. |
| `CalmRow`, `RowList` (`row.tsx`) | `.orow` | Flat hairline row: dot · name/host · plain sentence · tech (Controls) · status word. |
| `AlreadyOn` (`already-on.tsx`) | "Already on" list | Check-marked one-liners, each a link to *change*. |
| `Tech` (`tech.tsx`) | `.tech` | Mono muted technical line, rendered from Controls up. |
| `CodeView` (`code-view.tsx`) | "This page as code" | Tabs (swarmy.yaml / CLI / REST), copy button, source note. |
| `CalmTabs` (`calm-tabs.tsx`) | in-page tabs | Tab strip for a nav row's pages (Network: Domains · Edge · Mesh · Geo-DNS · Email). |
| `StatusWord` (`status-word.tsx`) | `.word` + `.dot` | The five-word status vocabulary: Online · Deploying · Needs you · Offline · Idle. |

Shell (`components/shell/*`): the sidenav becomes the `rnav` anatomy —
workspace row, coral **Deploy an app**, **Ask or jump… ⌘K**, seven rows
(Overview · Apps · Servers · Network · Data │ Activity · Settings), the
"Show me" dial and the user row. Mobile tab bar: Overview · Apps · `+` ·
Servers · Activity. `SectionHeader` and `PageHeader` keep their props but
render the calm header, so every existing page adopts the new chrome at once;
each slice then rewrites its pages to the board.

Tokens (`apps/app/src/styles/globals.css`, app-only so the marketing site is
untouched): `--nav` (navy in both themes), `--code` (code panel), and
text-safe tone colours `--tone-ok/warn/bad/info/mesh` that meet 4.5:1 on
both the light and the dark background (the `--status-*` fills don't, as text,
in light).

## 3. Route → board map

Routes keep their URLs (REST/SDK and bookmarks unchanged). New hub routes:
`/deploy`, `/network`, `/data`, `/activity`. The nav row a route lights is set
in `lib/destinations.ts`.

| Nav row | Route | Board(s) | Slice |
|---|---|---|---|
| Overview | `/overview` | RHome, Main (Welcome, empty estate), RWelcome (pick your depth), RChecklist (Worth doing next), Phone | S1 |
| Apps | `/` | RHome "Your apps", Estate / EstateLight (map is a view toggle, never nav) | S1 |
| Apps | `/stacks/$name` (Overview tab) | RApp, AppCanvas, ServiceSheet, Move | S1 |
| Apps | `/stacks/$name/{config}` | AppVariables, EnvPaste, RSecrets | S2 |
| Apps | `/stacks/$name/{releases}` | AppRollout, TimeTravel, RPromote, Environments, BranchPreviews | S2 |
| Apps | `/stacks/$name/{settings}` | AppScaling, AppPlacement | S2 |
| Apps | `/stacks/$name/{messaging}` | AppJobs, QueueStudio (`queues.$cluster`) | S2 |
| Apps | `/stacks/$name/{data,studio}` | DataStores, PgDetail, PgBackups, RDatabase, DbStudio | S2 |
| Apps | `/stacks/$name/{observability,errors,analytics,replays,rum-settings}` | Logs, Errors, Analytics, Replay, ReplaySettings, ObsSettings | S2 |
| Apps | `/stacks/$name/{network,access}` | DomainProtect (app domains), AppAccess | S2 |
| Apps | `/services/$id`, terminals | ServiceSheet, Logs | S2 |
| (verb) | `/deploy` (new), `/blueprints`, `/stacks/new`, `/services/new` | Deploy, RDeploy, Templates, Configure, GitConnect, GitDetect, YamlEditor, PrPlan, Deploying, Live | S3 |
| Servers | `/nodes`, `/nodes/$id` | Servers, RUpkeep | S3 |
| Servers | `/nodes/new` | AddServer | S3 |
| Network | `/network` (new) | Network (Domains), DomainAdd, DomainVerify, Connections | S4 |
| Network | `/ingress` | EdgeSettings, DomainProtect | S4 |
| Network | `/networking` | Mesh, MeshConfig, RLaptop | S4 |
| Network | geo (inside `/network`) | GeoDns | S4 |
| Network | `/email` | Email | S4 |
| Data | `/data` (new) | Data, DataStores (estate view) | S4 |
| Data | `/data/buckets` | BucketDetail | S4 |
| Data | `/backups` | Backups, RDumps | S4 |
| Data | `/ai` | (no board; follows Data + CliMcp patterns) | S4 |
| Activity | `/activity` (new), `/incidents`, `/incidents/$id` | Activity, ROffline (empty/error states) | S5 |
| Activity | `/alerts` | AlertRules, Channels | S5 |
| Activity | `/audit`, `/cost` | Activity (audit), Billing | S5 |
| Settings | `/settings` | Settings (Workspace), RClusters | S5 |
| Settings | `/settings/access`, `/governance` | Members, Settings (access & guardrails), RAccess, RSso | S5 |
| Settings | `/settings/api-keys` | ApiKeys, CliMcp, TwoFactor | S5 |
| Settings | `/ci`, `/ci/$id` | RegistryCI, Registries, BuildLogs | S5 |
| Settings | `/settings/platform` | Platform, Upgrade | S5 |
| — | `/login`, `/app-login`, `/device` | RSignIn (restyle the `components/auth/*` pieces; route files hold demo hooks) | S5 |
| — | `$` catch-all, error/empty states | ROffline | S0 |
| — | ⌘K palette | Command | S0 (restyle), later: intents |

Boards not rebuilt (features removed; see `git log`): workflows, old previews,
the off-site mirror, Tailscale/WireGuard/direct connect, Traefik/nginx/HAProxy,
the services builder/list, the resilience score.

## 4. Summary-depth glossary

| Say | Not (Controls/Code only) |
|---|---|
| copies | replicas |
| standby copy | replica, secondary |
| switch-over | failover, promote |
| server | node |
| app | stack |
| front door / edge | ingress, driver |
| private network | overlay, WireGuard, mesh IP |
| saved / backed up | snapshot, restic, PITR |
| put back vN | rollback |
| address | domain record, CNAME (Controls) |

## 5. Order

| Slice | Ships | Owner |
|---|---|---|
| S0 Foundation | tokens, `components/calm/*`, depth context, new sidenav + mobile bar, `SectionHeader`/`PageHeader` → calm header, hub routes, destinations remap, this doc | lead |
| S1 Overview + Apps | `/overview`, `/`, stack header + Overview tab | helper A |
| S2 App workspace tabs | every `/stacks/$name/*` tab, `/services/*` | helper B |
| S3 Deploy + Servers | `/deploy`, blueprints, new stack/service, `/nodes*` | helper C |
| S4 Network + Data | `/network`, `/ingress`, `/networking`, `/email`, `/data`, buckets, backups, AI | helper D |
| S5 Activity + Settings + sign-in | `/activity`, alerts, incidents, audit, cost, every `/settings*`, `/governance`, `/ci*`, auth pieces | helper E |
| S6 Verify | Playwright screenshots of every route × depth in demo mode, console clean, a11y pass (buttons/links, 4.5:1, 44px targets) | lead |

Each slice: `bun --filter @swarmy/app typecheck`, the app's `bun test`, demo
mode renders with no console errors, a pathspec commit.

## 6. Verification (S6)

- Demo mode, 51 routes × Summary/Controls/Code, dark: axe WCAG 2.2 AA clean on
  every route, no console errors, one coral action (0 where nothing needs doing).
  Light (Summary): clean. 390px: clean; touch targets ≥ 44px on touch screens.
- `bun --filter @swarmy/app typecheck`, `@swarmy/web`, `@swarmy/ui` typecheck;
  `apps/app` bun test (52); `build:demo` + `apps/e2e/demo-smoke.ts` pass.
- Harness: scratchpad `rd/audit.ts` (axe + coral count + touch targets) and
  `rd/shots.ts`.

## 7. Deferred (tracked here)

- Route moves in plan §B.2 (`/ingress` → `/network/edge`, etc.). URLs stay; the
  nav and tabs present the new IA. Move with redirects in a later release.
- A server-side user preference for depth (localStorage per user today).
- ⌘K plain intents ("undo analytics", the Command board's preview pane) — the
  palette is restyled with apps/servers and depth commands only.
- Boards not built for lack of a data source: TimeTravel, Connections
  (app ↔ app), RClusters (multi-cluster), MeshConfig access-rule list, backup
  drill steps, per-copy CPU/memory on Scaling, the AppScaling sleep chart.
- RSignIn two-column layout needs `routes/login.tsx` / `app-login.tsx` (demo
  hooks live there); the sign-in pieces in `components/auth/*` are restyled.
- Code views without a public API (alerts, incidents, cost, policies,
  guardrails, platform) are read-only JSON/labels; they gain REST when it exists.
- Glossary leaks from other packages at Summary: `@swarmy/abac` describePolicy
  says stacks/nodes/mesh; some server alert messages say replicas.
- Per-app swarmy.yaml from git: the app Code view shows the live spec as
  compose (read-only); there is no stack-spec query yet.
- Files over the 150-line limit carried over: `errors/issue-detail.tsx`,
  `errors/issues-list.tsx`, `errors/errors-setup-card.tsx`,
  `queues/studio/queue-detail.tsx`.
