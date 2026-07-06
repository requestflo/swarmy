# The shape of swarmy — estate & stacks, planes, and the promises

**Status: canonical product design (2026-07). The umbrella doc — it indexes every
other product doc and states the promises they all keep. No single skill owns it;
it references the `hot-signal-design`, `docker-native-storage`, `add-feature-slice`,
and `start-epic` skills where they apply.**

## What swarmy is (positioning)

swarmy is **your own cloud, on your own hardware**: a self-hosted mini-cloud
platform for VPSs, home servers, office boxes and bare metal. Docker Swarm is
the substrate; swarmy adds the cloud-shaped layers — private mesh, a public
edge with protection, tunnels for zero-firewall exposure, object storage,
managed databases with PITR, GeoDNS, backups/DR, governance — so a person or
small team gets cloud-like power **without cloud-provider lock-in**. Two
commitments follow: the first node bootstraps everything (**no required
swarmy cloud** — your cloud must not depend on ours), and the agent that
manages Docker lives *outside* Docker (a host-level binary), because the
thing that repairs the platform can't ride on the platform being healthy.
The current delta between this positioning and the code is tracked in
`plans/roadmap-mini-cloud.md`.

## The feeling we are building

swarmy should feel like it has exactly two altitudes, and you always know which
one you're at. There is the **estate** — everything you own, one screen, kept an
eye on — and there is a **stack workspace** — one app, opened up, operated. The
whole product is that one sentence made physical: *a stack is the unit you
operate; the estate is what you keep an eye on.*

Someone running swarmy should be able to:

1. Land on **Overview** and read the estate like a dashboard: nodes online,
   services running, alerts firing, incidents open — with the honest headline
   "Nothing on fire. Quiet and green." when there's nothing to do, and a "Get set
   up" checklist when there is (add a node · deploy something · point a domain ·
   set up backups · turn on alerts).
2. See a card they care about — a wobbling deployment, a resilience score, a
   stack tile — and **click straight into the workspace that owns it**. No card
   is a dead end; every card is a door into the app it's about.
3. Open **Stacks** ("4 stacks discovered") and see every app on the swarm grouped
   by stack, each with a live status dot and "10/11 containers up" — then open one
   and land on its **live service canvas**: draggable service cards, dependency
   lines, ports and images and per-replica dots all visible at once.
4. Move along that stack's **tabs** — Overview · Data · Messaging · Observability ·
   Network · Config · Backups · Releases · Settings — and operate the whole app
   from one place, never hunting through a global menu for "the databases page."
5. Trust that everything they flip is **off by default, pluggable, and audited** —
   and that if swarmy vanished tomorrow, the stack keeps running on plain
   `docker stack deploy`, because Docker was the source of truth the whole time.

It should never feel like a control panel bolted onto a cluster. It should feel
like the cluster grew a face — one that speaks in plain words, accents the word
that matters in coral ("Needs you.", "online.", "discovered."), and offers one
obvious next action per screen.

## How it works (the spine)

Every surface in the app, on both planes, rides the same wire:

```
┌─────────────────────────── the estate plane ───────────────────────────┐
│  Overview · Stacks · Infrastructure · CI · Mesh · AI · Object storage · │
│  Guardrails · Exposure · Cost · Access · Audit · Alerts · Incidents     │
│                          "keep an eye on"                               │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ every card / tile is a Link INTO the owning workspace
                ▼
┌────────────────────── a stack workspace (/stacks/$name) ────────────────┐
│  Overview(canvas) · Data · Messaging · Observability · Network · Config  │
│           · Backups · Releases · Settings          "operate an app"      │
└───────────────┬─────────────────────────────────────────────────────────┘
                │
       apps/app (Vite SPA, Hot Signal)
                │  tRPC v11 (@trpc/tanstack-react-query), org-scoped, audited
                ▼
       apps/api  — the CONTROLLER (never touches a node's Docker socket)
                │  reads served from the in-memory hub snapshot; only
                │  MUTATIONS dispatch a command down a node's socket
                ▼  outbound WebSocket (agent dials OUT; controller never in)
       apps/agent on each node → LOCAL Docker socket → the swarm
```

Four ideas, one story:

- **Two planes, one spine.** The estate plane and the stack workspace are just two
  altitudes over the *same* dashboard→tRPC→controller→agent path. No plane has its
  own backend; both read the same org-scoped tRPC routers and the same hub
  snapshot. The IA — a slim global sidenav vs. an in-stack tab strip — is the whole
  distinction between "watch" and "operate."
- **Reads are instant; mutations are commands.** The dashboard stays snappy because
  `list`/`inspect`/`stats` come from the hub's in-memory snapshots the agent
  already streams — no round-trip to a node. Only a change (deploy, scale, toggle a
  role) sends a command down the socket. This is why Overview can show the whole
  estate without hammering any Docker daemon.
- **The controller never reaches in.** The only runtime dependency is the agent's
  outbound WSS. swarmy works on a box behind NAT with zero inbound ports, and no
  feature — however deep — is allowed to add a path where the controller opens a
  socket to a node. See `compute-and-onboarding.md`.
- **Every feature is a slice of this same shape.** Adding a capability means db
  model → agent protocol message → tRPC service+router → a surface on one of the
  two planes. The shape never changes; only which tab or card it lands on does.
  See `skill("add-feature-slice")` and `skill("start-epic")`.

## Roles and where truth lives

The estate/stack split is not cosmetic — it decides *where a surface lives*, and
that decision is encoded, not vibes:

- **The global sidenav is deliberately slim: estate-level concerns only.** Its
  single source of truth is `apps/app/src/lib/destinations.ts` — Overview, Stacks,
  Infrastructure, then grouped sections (Deploy · Platform · Operations ·
  Governance · Settings). If a surface belongs to *one app* — its databases,
  caches, queues, workflows, webhooks, observability, secrets, configs, ingress
  routes, backups, releases — it is **not** allowed in the global nav.
- **Everything app-scoped hangs off `/stacks/$name`.** The tab registry is
  `apps/app/src/lib/stack-nav.ts` (`STACK_TABS`). Adding an app-level capability
  means adding a tab there, never an item to the global sidenav. The `swarmy-system`
  stack (shared plumbing — collector, ingress, storage, mesh control-plane) shows
  only the `systemSafe` subset (Overview + Observability), because it's plumbing,
  not a user app.
- **Every estate card opens the owning workspace.** Overview's stack tiles,
  deployment rollups, and resilience prompts are all `Link`s into a stack (or into
  the tab that owns the detail). The estate never *is* the control surface — it's
  the index over the workspaces that are. "Per-stack history lives in each stack
  workspace" is a promise the code keeps by routing, not duplicating.
- **Docker is the source of truth; the DB is only swarmy's own.** Node roles,
  region, per-node cost, service labels, mesh membership — all live on Docker
  labels/configs/secrets, read live, never shadowed in a column. The DB holds only
  swarmy's identity/access/audit/queryable-history. Every "swarmy stores it on the
  node itself" line in the UI is this rule surfacing. See the
  `docker-native-storage` skill.
- **Demo mode is the same app with the backend swapped out.** `?demo` (or a demo
  build) flips `apps/app/src/demo/is-demo.ts`, and an in-memory store + resolvers
  (`apps/app/src/demo/*`) stand in for tRPC — *no DB, no auth, no agents*. Because
  both planes ride one spine, the entire estate and every workspace tab render
  from seeded data with zero backend. The two-plane shape is what makes a
  fully-interactive public demo possible.

## Estate & stack behaviour (the promises every surface keeps)

These are the cross-cutting commitments — the reason the product feels coherent
across a dozen domains. Every product doc in this folder is one domain honouring
them:

- **Docker is the source of truth — no lock-in.** Config lives on Docker
  labels/configs/secrets; HA templates "store their compose so the exact stack runs
  without swarmy"; managed data keeps its secrets in Docker secrets. Delete swarmy
  and your stacks keep running.
- **Off by default, pluggable, individually disableable.** Mesh driver is "None"
  by default; observability is a per-stack toggle; ingress is optional; guardrails
  are a master switch. "None stays the default" is a design stance, not an
  omission.
- **Everything is audited.** Guardrail blocks and overrides, DR drills,
  direct-connect routes, deploy decisions, role toggles — "every … is on the
  record." The audit log is a first-class estate surface, not a debug feature.
- **Safety is the product, not a mode.** Deploy health gates + auto-rollback,
  production guardrails, safe DR drills you run on a schedule "not during an
  outage," exposure violations that alert but never silently mutate your ports,
  image signing + CVE gates. The edge's "degraded beats dark" is the same instinct.
- **One-command simplicity.** Enroll a node with one pasted line; deploy from a
  blueprint in one click; point a domain and get TLS automatically. The happy path
  asks as little as possible.
- **The Hot Signal voice carries all of it.** Plain-words explanations, a
  contextual coral accent word in every headline, one coral CTA per screen, honest
  empty states that sell the next action. The tone is a product feature; it lives
  in the `hot-signal-design` skill.

## Failure modes (designed, not accidental)

| Situation | Behaviour |
|---|---|
| swarmy (the controller) is down | Stacks keep running — Docker was the source of truth. Agents retry the outbound WSS with jittered backoff; reads resume from the hub snapshot when it returns. Nothing on a node depends on the controller at runtime. |
| A card points at a workspace that no longer exists | Estate cards are typed `Link`s; a removed stack drops off the Stacks plane and Overview tiles rather than deep-linking into a 404. The estate reflects live truth, not a cached menu. |
| A feature is disabled for the org | Its estate nav item / stack tab still resolves, but the surface shows the off-state and its one CTA to turn it on — never a blank or an error. Off is a first-class state. |
| Demo store hasn't finished seeding (async) | Surfaces render their empty/loading state, then fill — the two-plane shell never blocks on data. (A full page reload resets the in-memory demo store by design.) |
| A surface author reaches for the global sidenav for an app-scoped feature | It's a bug against the IA: app-scoped surfaces belong on a `/stacks/$name` tab (`stack-nav.ts`), estate-scoped ones in `destinations.ts`. The split is enforced by where the registry lives, not by convention alone. |

## Explicitly rejected

- **A canvas-filtering "one big graph" instead of two planes.** Tried in the
  command-canvas redesign; the operator's real mental model is "the infrastructure
  vs. the application stack are two separate things." Node placement is a *badge on
  an app card* and a fact on Infrastructure — not a tab that filters one mega-graph.
- **A fat 15-item flat sidenav that mixes estate and app concerns.** It buried "the
  databases for *this* app" next to "the whole org's audit log." Splitting into an
  estate sidenav + per-stack tab strip is what makes each altitude legible.
- **Duplicating per-stack detail up onto the estate.** The estate *rolls up and
  routes*; it does not host the controls. Deployment history, backups, releases
  live in the owning stack workspace, linked from Overview — one home per fact.
- **A DB that mirrors Docker/swarm state so the dashboard can read it faster.** It
  drifts. Reads come from the live hub snapshot; the DB holds only swarmy's own
  identity/access/audit. See `docker-native-storage`.
- **Making features on-by-default because "it's easier."** Off-by-default and
  individually disableable is the promise; a feature that can't be cleanly turned
  off doesn't ship.

## Implementation map

This doc is the index; each domain has its own product doc + paired skill. Start
here, then go deep:

- **The IA, encoded**: `apps/app/src/lib/destinations.ts` (global/estate nav —
  the slim sidenav) and `apps/app/src/lib/stack-nav.ts` (`STACK_TABS`, the
  per-app workspace tabs, incl. the `systemSafe` subset for `swarmy-system`).
- **The shell that renders both planes**: `apps/app/src/components/shell/*`
  (`app-shell.tsx`, `sidenav.tsx`, `command-palette.tsx`, `mobile-chrome.tsx`),
  under the `hot-signal-design` skill.
- **The two planes' routes**: `apps/app/src/routes/_authed/overview.tsx`,
  `.../index.tsx` (Stacks), `.../nodes/*` (Infrastructure), and the stack
  workspace `.../stacks/$name.*.tsx`.
- **Demo mode**: `apps/app/src/demo/is-demo.ts` + `apps/app/src/demo/*` (store +
  resolvers) — the backend-less twin of the same spine.
- **The spine itself**: `apps/api` (controller/gateway), `apps/agent` (dial-out
  agent), `packages/core/src/protocol/*` (wire), `packages/trpc` (routers +
  services + hub). Building a new slice across all of it: `skill("add-feature-slice")`;
  starting a roadmap epic: `skill("start-epic")`.
- **The companion product docs** (this doc's siblings — each the "why" for one
  domain, indexed in `docs/product/README.md`): `compute-and-onboarding.md`
  (nodes + the dial-out spine) and `edge-network.md` (the global edge) are canonical
  today; the managed-data, messaging-and-automation, ingress-and-exposure,
  observability, deploy-and-releases, resilience-and-dr, cicd-and-registry,
  mesh-networking, ai-gateway, governance-and-access, and cost domains each carry
  the promises above into their own surface.
