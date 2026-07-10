# docs/product — product thinking, decisions, and vision

This folder holds **product-level design documents**: the "why it should feel this
way" thinking that sits above any single epic or PR. It is the durable home for
the vision conversations that otherwise live only in chat threads.

How it relates to the other folders:

- **`docs/product/`** (here) — what the product IS and how it should feel to the
  person running swarmy. Written for humans first; survives implementation churn.
  When a decision here changes, the change is deliberate and discussed.
- **`plans/`** — epic-scoped implementation designs and the roadmap. Plans may be
  superseded; when a plan and a product doc disagree, **the product doc wins** and
  the plan gets a supersession note.
- **`.claude/skills/`** — operational instructions for working IN the codebase
  (conventions, invariants, file maps). Skills reference product docs for the
  "why"; product docs reference skills for the "how".

Each product doc names its paired **skill** (the in-codebase "how") in its
_Implementation map_; the skill's description points back here. Start with
[`product-shape.md`](./product-shape.md) — it frames the whole product; the rest
go deep on one area each.

### The whole product

- [`product-shape.md`](./product-shape.md) — the umbrella: the estate ⇄ stack
  duality, the two planes, and swarmy's cross-cutting promises (Docker is the
  source of truth, off-by-default & pluggable, everything audited, one-command
  simple). _Skills: `hot-signal-design`, `docker-native-storage`, `add-feature-slice`._

### Compute & deploy

- [`compute-and-onboarding.md`](./compute-and-onboarding.md) — nodes, the agent
  dial-out model, and one-command onboarding. _Skill: `agent-handlers`._
- [`node-recovery.md`](./node-recovery.md) — how a dark node always comes home:
  the on-box `swarmy-agent` CLI/TUI, the self-healing one-liner + hostname
  re-adoption, the recovery beacon, and controller-dark rescue backups. (Operator
  runbook: [`../NODE-RECOVERY.md`](../NODE-RECOVERY.md).) _Skill: `node-recovery`._
- [`deploy-and-releases.md`](./deploy-and-releases.md) — the service canvas, GUI
  builder + lossless compose, blueprints, previews, and canary/rollback releases.
  _Skills: `add-feature-slice`, `docker-native-storage`._
- [`cicd-and-registry.md`](./cicd-and-registry.md) — git → build on your nodes →
  in-swarm registry → live, with CVE scans, signing, and GC. _Skill: `cicd-registry`._

### Networking & the edge

- [`edge-network.md`](./edge-network.md) — the global edge: geo-DNS, nameserver
  nodes, region-aware Caddy routing, and the mesh that ties it together.
  ([`CHANGELOG-edge-network.md`](./CHANGELOG-edge-network.md) records that rework's
  breaking changes.) _Skill: `geo-edge-routing`._
- [`ingress-and-exposure.md`](./ingress-and-exposure.md) — pluggable ingress
  drivers, TLS/tunnels, and public/private exposure enforcement.
  _Skills: `scaffold-ingress-driver`, `geo-edge-routing`._
- [`mesh-networking.md`](./mesh-networking.md) — the zero-trust WireGuard mesh and
  audited direct-connect to a single service. _Skill: `mesh-networking`._

### Platform services

- [`managed-data.md`](./managed-data.md) — managed Postgres/cache/search/vector and
  Garage object storage, wired automatically. _Skill: `managed-data-services`._
- [`messaging-and-automation.md`](./messaging-and-automation.md) — queues,
  workflows, jobs, and inbound/outbound webhooks. _Skill: `reconcile-workers`._
- [`observability.md`](./observability.md) — per-stack OpenTelemetry into one
  ClickHouse store, plus alerts, incidents, and status pages. _Skill: `observability-otel`._
- [`ai-gateway.md`](./ai-gateway.md) — one gateway for model calls: server-side
  provider keys, revocable virtual keys, usage + cost metering. _Skill: `add-feature-slice`._

### Resilience & governance

- [`resilience-and-dr.md`](./resilience-and-dr.md) — backups, controller
  self-backup, the resilience score, and safe DR drills. _Skill: `backups-dr`._
- [`governance-and-access.md`](./governance-and-access.md) — the org-scoped
  procedure chain, Cedar ABAC, guardrails, audit, cost, and identity.
  _Skills: `auth-abac`, `rest-api-surface`._

Cross-cutting code skills without a single owning doc: `reconcile-workers`
(the controller convergence-loop pattern), `testing-conventions` (test layout +
the required CI gates), and `rest-api-surface` (the public REST/SDK/Terraform
front door).
