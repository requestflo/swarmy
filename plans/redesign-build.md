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
| Apps | `/stacks/$name` (Services tab) | RApp, AppCanvas, ServiceSheet, Move | S1 |
| Apps | Domains · `/stacks/$name/network` | DomainProtect (app domains) | S2 |
| Apps | Data › Databases · Studio · Queues · `/stacks/$name/{data,studio,queues,queues/$cluster}` (cache/search/vector anchored `#cache` `#search` `#vector` on `data`) | DataStores, PgDetail, RDatabase, DbStudio, QueueStudio | S2 |
| Apps | Observability › Logs & traces · Replays · Errors · Analytics · Settings · `/stacks/$name/{observability,replays,errors,analytics,rum-settings}` | Logs, Replay, Errors, Analytics, ReplaySettings, ObsSettings | S2 |
| Apps | Access · `/stacks/$name/access` | AppAccess | S2 |
| Apps | Config › Variables & secrets · `/stacks/$name/config` | AppVariables, EnvPaste, RSecrets | S2 |
| Apps | Config › Scaling · Health & rollout · Placement & volumes · Jobs & previews · `/stacks/$name/config/{scaling,rollout,placement,jobs}` | AppScaling, AppRollout (settings), AppPlacement, AppJobs, BranchPreviews | S2 |
| Apps | Backups · `/stacks/$name/backups` | PgBackups, Backups (app) | S2 |
| Apps | Releases · `/stacks/$name/releases` | AppRollout (history, canary in flight), RPromote, Environments | S2 |
| Apps | Source · `/stacks/$name/source` (read-only live spec) | AppCanvas "Source" | S2 |
| Apps | old `/stacks/$name/settings` → `config/scaling`, `/stacks/$name/messaging` → `config/jobs` (`#queues` → `queues`) | (redirects, `lib/stack-nav-match.ts`) | S2 |
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
- Boards not built for lack of a data source: RClusters (multi-cluster),
  MeshConfig access-rule list, live backup drill steps, per-copy CPU/memory on
  Scaling. (TimeTravel, Connections and the Scaling sleep chart had their data
  arrive and are built — §9.)
- Writing to git from the dashboard (commit swarmy.yaml, open a PR) has no
  backend; every "Open PR" / "Make it permanent" / "Add to swarmy.yaml" on the
  boards is left out until it does. It is the biggest single unlock left.
- Code views without a public API (alerts, incidents, cost, policies,
  guardrails, platform) are read-only JSON/labels; they gain REST when it exists.
  ⌘K "put back" shows `releases.rollback` for the same reason.
- Per-app swarmy.yaml from git: the app Code view shows the live spec as
  compose (read-only); there is no stack-spec query yet.
- ⌘K intents are a fixed grammar (lib/intents.ts); free-form questions
  ("why is X slow") jump to the page with the answer rather than answering.

## 8. Done after S6 (follow-ups)

- `/nodes/new` mints a join link only on "Create join link"; an unexpired
  one from the same tab is reused.
- One headline per app page: tab sentences render as a lede
  (`UnderPageHeadline`).
- Plain words from other packages: abac policy sentences, alert messages,
  alert rule catalog, health reasons.
- The depth default is saved server-side (`org.myPreferences`,
  `user_preference` table); localStorage is the cache.
- ⌘K plain intents with the preview pane.
- RSignIn two-column sign-in (`components/auth/sign-in-layout.tsx`); the
  DEMO_BUILD hooks in `routes/login.tsx` / `app-login.tsx` are unchanged.
- The four files over 150 lines are split.
- 2026-09-26 (owner): the app workspace takes the boards' 9-tab IA with
  sub-tabs (Services · Domains · Data · Observability · Access · Config ·
  Backups · Releases · Source; `lib/stack-nav.ts`); old URLs redirect.
  Source is read-only; dashboard editing of swarmy.yaml stays deferred (§7).

## 9. Boards rebuilt to the canvas (2026-10-23)

The 2026-09-25 pass gave every route the Calm Layers structure; this pass
rebuilt boards to their own drawing (their visual, interaction and copy), on
data that exists. Each line: the board, where it lives, and what was left out
because no backend provides it.

| Board | Route | Left out (no data / backend) |
|---|---|---|
| 9 Move | `/nodes` (drag or Move…) | disk fit (volume sizes aren't reported), Undo (the old copy stays on the source and the mover refuses a non-empty destination), ⌥-drag to add a copy |
| 10 Time travel | `/stacks/$name/time-travel` (from Releases) | whole-app restore, rows written since, historical db size, service-graph edges |
| 11 Servers | `/nodes` (map first, list toggle) | provider, restart agent (24 h sparklines arrived in the third pass) |
| 14 Mesh | `/networking` (map) | per-link latency and bytes (relayed is per server, so every link of a relayed server draws through the relay) |
| 15 Data | `/data` | lifecycle/CORS lines, moving a database by drag |
| 16 Backups | `/backups` | live drill steps, server-loss drill, snapshot download, offsite mirror lag, resilience score (removed on purpose) |
| 20 Upgrade | `/settings/platform` | release channels beyond Stable/Edge (the epic defines none) |
| 21 Phone | `/overview` below `lg` | estate uptime, incident owner / "take for 30 min", rollback duration |
| 23 Connect a repo | `/deploy?source=git` | "What we found" detectors (Postgres / Redis / S3 / cron), App #N |
| 34 Scaling | `/stacks/$name/config/scaling` | Open PR, cost per size, cold-start time |
| 40 Postgres backups | `/stacks/$name/backups` | offsite copy for db schedules, WAL-gap check, restore progress and row diff, PITR from an older base backup (wal-g starts from the newest) |
| 42 Bucket | `/data/buckets/$name` | lifecycle, CORS, growth forecast, per-key last used, public-bucket approval |
| 44 Connections | `/network/connections` | REST for connect/endpoints, a custom DATABASE_URL name |
| 45 Alert rules | `/alerts` | backtest for signals other than error rate and disk |
| 54 Registries | `/ci` | — |
| 55 Channels | `/alerts` | saved test receipts, per-channel "gets N of 14 rules" |
| 56 Sign-in (part) | `/settings/access` | password toggle, "must accept with SSO" invites |
| 61 Errors | `/stacks/$name/errors/…` | — |
| 64 Queue studio | `/stacks/$name/queues/$cluster` | depth-vs-workers history, autoscale cooldown |
| 67 CLI & MCP | `/settings/api-keys` | the in-page "Is my repo ready?" check (runs locally only) |

**Second pass (same day):**

| Board | Route | Left out (no data / backend) |
|---|---|---|
| 7 App canvas | `/stacks/$name` | the sign chip (no per-image signing record), per-part sparklines, saved data-node positions |
| 12 Add a server | `/nodes/new` | "direct to home-lab · 0.4 ms" (no link latency) |
| 13 Network | `/network` | p50 per edge, a per-edge rendered Caddyfile |
| 19 Settings | `/settings` | — (the "three ways" action is stack removal: the only change curl, the CLI and Terraform all share) |
| 26 PR plan | Releases › plan drawer (Graph) | the YAML diff tab, unchanged boxes' connector lines |
| 30 Domain detail | `/stacks/$name/network` | issued date, "covers", blocked req/min and receipts, renewals, Renew now, CAA |
| 31 Edge settings | `/ingress` | an issuance count (shows certificates live now), the ask-decision log, other proxy drivers (removed) |
| 32 Geo-DNS | `/network/geo-dns` | simulate an edge down, TTL above 120 s, the "answer with everyone" off switch (the engine always spills, by rule) |
| 33 Variables & secrets | `/stacks/$name/config` | shared-vs-override layering, the "declared in swarmy.yaml" lock, Add to swarmy.yaml |
| 35 Health & rollout | `/stacks/$name/config/rollout` | writing the health check, Test now, the error-% trip on the safety gate |
| 36 Placement & volumes | `/stacks/$name/config/placement` | volume sizes, mesh latency |
| 37 Jobs & workers | `/stacks/$name/config/jobs` | worker throughput and concurrency, preview TTL editing |
| 39 Postgres | `/stacks/$name/data/$cluster` | per-replica LSN, pg_stat_statements/postgis toggles, PgBouncer, version/maintenance, memory setter, disk, cost |
| 41 Cache & search | `/stacks/$name/data` | eviction/persistence pickers (fixed today), hit-rate history, index list, reindex, engine switch |
| 43 Mesh settings | `/networking/settings` | the auto-join toggle, MTU fix, access rules, bytes per peer |
| 52 Platform | `/settings/platform` | 4 weeks of traffic (the series keeps 7 days) |
| 57 Environments | `/stacks/$name/releases` | "Clone as new environment", per-lane domains |
| 58 Paste .env | `/stacks/$name/config/paste` | the environment target, locked git-managed rows |
| 59 Session replay | `/stacks/$name/replays/$id` | a request id (the data has none) |
| 60 Replay settings | `/stacks/$name/rum-settings` | — |
| 62 Web analytics | `/stacks/$name/analytics` | the checkout funnel, a visit-length delta |
| 63 Database studio | `/stacks/$name/studio` | slow-query p95 and calls per 24 h, index suggestions |
| 68 Branch previews | `/stacks/$name/config/previews` | editing preview rules, "sleeps after 2 h idle" |

Backend fixes found while building them:

- Sleep when idle counted only the activator, so a busy service was put back
  to sleep one idle window after every wake; it now reads the edge traffic ring.
- `decommission.moveService` ran its refusals in the background, so a refused
  move vanished; they now run first (`planServiceMove`) and return the reason.
- The MCP server gave a Deploy key (read + deploy) only read tools; each tool
  now needs what its REST route needs.
- A platform release now carries each component's current tag, so third-party
  images show from → to on the upgrade screen.

**Third pass (2026-10-24):**

| Board | Route | Left out (no data / backend) |
|---|---|---|
| 22 Estate map, light | Apps › Map | link latency labels, uptime |
| 24 Repo scanned | `/deploy?source=git` (after Link & scan) | "Deploy now, commit later" and "Commit … PR #1" (no git write path) |
| 25 swarmy.yaml editor | `/stacks/$name/source` | Commit & open PR (no git write path); autocomplete in flow mappings |
| 27 Build logs | `/ci/$buildId` | a release version number (uses the short commit), per-stage log filtering |
| 48 Members & roles | `/settings/access` | Viewer/Developer roles (owner decision), Enforce SSO, multi-app invites |
| 51 CI & registry | `/ci` | — |
| 65 App access | `/stacks/$name/access` | per-path who-can-enter, provider toggles, recent sign-ins |
| 66 Email | `/stacks/$name/config/email` | the per-server port-25 test |

Also this pass: the Servers 24 h sparklines (11), per-address visits on the
routing diagram and Domains tab (13, 30), the upgrade's pause / resume /
abandon (20), restore-as-a-copy creating its own database and live DR drill
steps (10, 16, 40).

Found, not fixed (worth deciding):

- Board 52 offers "All minor updates" for auto-patching; the upgrades epic
  decides patch releases only. Decide before building it.
- A refused point-in-time restore still takes the safety backup and a brief
  restart before the agent refuses (moving the check earlier needs a new
  agent command, which older agents would drop).
