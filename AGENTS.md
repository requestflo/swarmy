# swarmy: rules for agents

swarmy is a self-hosted mini-cloud on Docker Swarm: your own cloud, on your own hardware.
A controller (`apps/api`) runs on a manager; a dial-out agent (`apps/agent`) runs on every
node; the dashboard (`apps/app`) talks tRPC (`packages/trpc`) to the controller. The
README has the picture; `docs/product/` has the why.

This file is the rulebook. Every rule below cites an **Accepted** record; the record wins
over this summary. All records: [`docs/RECORDS.md`](docs/RECORDS.md). How they work:
[`docs/decisions/README.md`](docs/decisions/README.md).

## Every session

1. Before planning, read this file and every Accepted record that covers the files you
   will touch (search `docs/RECORDS.md` by area). Proposed records are context, not law.
2. Load the skill for the area (table below) before editing its files.
3. If the task conflicts with an Accepted record: stop, cite its ID, and offer to change
   the task or draft a superseding record. Never work around a record.
4. Never set a record's status to Accepted or Rejected; only the founder does. Write new
   decisions down as Proposed (DR-001); a decision agreed in chat isn't one until then.
5. Change code and the records it affects in the same pull request. Cite IDs in tests,
   at deliberate oddities in code, and in a `Refs:` commit trailer.
6. Run `bun run scripts/records.ts check` after touching any record or this file.

When sources disagree: an Accepted record, then the product doc, then the skill, then the
plan. `plans/ROADMAP.md` is the open-work list.

## Paramount: configurable by default

- BR-098: works with a sensible default and no setup, and a team can change any behaviour
  or swap the tool for a job without code, a fork or a release. It outranks every other
  requirement unless a decision record says why not.
- BR-099: a job with more than one common tool goes through a driver with one default.
- BR-100: a duration, threshold, retention or policy someone could want different is a
  named setting with a default, never a hard-coded constant.
- BR-101: a setting is stored once at its owner (estate, org, app, service), shows the same
  in the dashboard, swarmy.yaml, REST and Terraform, and its changes are audited.
- BR-102: imports from other platforms list what didn't translate, with why.
- BR-103: work beside tools a team keeps; connect to them as targets.
- BR-104: an org's choices can be saved as a profile and reused.
- BR-105: fixed only where a setting would break the org wall, the vault, the audit log or
  the no-inbound-ports rule, and a decision record says why.

## Principles every feature keeps

- BR-001: your own cloud, on your own hardware, with no cloud-provider lock-in.
- BR-002: no required swarmy cloud; the first node bootstraps everything.
- BR-003: Docker is the source of truth; delete swarmy and stacks keep running.
- BR-004: the controller never reaches in: nodes need zero inbound ports.
- BR-005: the agent is a host binary, so it can repair Docker.
- BR-006: features are off by default, pluggable and individually disableable.
- BR-007: everything is audited.
- BR-008: safety is the product: health gates, rollback, guardrails, drills, signing.
- BR-009: the org is a hard wall; assume hostile co-tenants.
- BR-010: one vault; a stored secret is never returned to a client.
- BR-011: the protocol only grows: new message types or optional fields, never rewrites.
- BR-012: one-command simple: one pasted line, one click, automatic TLS.
- BR-013: two altitudes, the estate and the app workspace.
- BR-014: every screen reads at Summary, Controls and Code.
- BR-015: the dashboard and the REST API ride the same org-scoped services.
- BR-016: the public demo runs with no backend.

## Decisions in force

Platform

- DR-002: Docker Swarm, not Kubernetes, Nomad or k3s.
- DR-003: licence FSL-1.1, becoming Apache 2.0 after two years.
- DR-004: two planes, the estate and the app workspace.
- DR-005: state lives on Docker labels, configs and secrets; the database holds only
  identity, access, audit and history. Use the `docker-native-storage` skill.
- DR-006: the agent is a host binary under systemd; a container only as fallback.
- DR-007: enrol with a pasted one-liner; the agent dials out. No SSH push.
- DR-008: the installer is POSIX sh, the token travels in the environment, HTTPS only.
- DR-009: node recovery is the same install line plus a fingerprint claim a person approves.
- DR-010: the controller store is embedded SQLite, streamed to Garage with Litestream.

Deploys and builds

- DR-011: compose is canonical; swarmy.yaml compiles to it.
- DR-012: builds are an agent command on your own builder nodes, rootless BuildKit.
- DR-013: zero-config builds use Railpack.
- DR-014: one `registry:2` service; not Harbor.
- DR-015: deploy by `@sha256` digest, never a floating tag.
- DR-016: one GitHub App per install with short-lived tokens; no stored PATs.
- DR-017: destructive GitOps steps wait for a person.
- DR-018: upgrades start with an admin's click; automatic patch releases are opt-in.
- DR-046: the dashboard writes to git through pull requests only, never the default
  branch; anyone with `service.configure` may open one; GitHub first.

Edge and network

- DR-019: swarmy-dns answers authoritatively per query; no anycast.
- DR-020: edge ports use host mode, not the routing mesh.
- DR-021: Caddy is the default edge, plus none and cloudflared.
- DR-022: certificates are node-local first, with one shared ACME account.
- DR-023: exposure violations alert and block the next deploy; ports are never removed.
- DR-024: Cloudflare Tunnel is a pasted token.
- DR-025: the mesh is self-hosted NetBird run by the agent, Headscale optional.
- DR-026: people reach apps through a per-app access router, default deny.
- DR-027: independent clusters at launch; a fleet hub later.

Data and resilience

- DR-028: database failover promotes only a copy proven caught up; otherwise it holds.
- DR-029: object storage is Garage.
- DR-030: volumes use engine-native copies and moves; ext4 only, never auto-format.
- DR-031: queues are a convention over a managed cache; no bundled broker.
- DR-032: backups use restic, one destination type for everything.
- DR-033: the controller backup passphrase is held by the founder; escrow is opt-in.
- DR-034: resilience is a list of what isn't protected, never a score.
- DR-035: drills restore into a throwaway cluster and show measured RPO and RTO.

Access, observability and AI

- DR-036: attribute-based policy, role as one attribute; destructive actions gated.
- DR-037: one audit writer, which also records every denial.
- DR-038: your own IdP plugs in and owns MFA; swarmy 2FA is optional.
- DR-039: one OTel collector and one ClickHouse, injected by env and labels only.
- DR-040: AI provider keys are encrypted in the controller (an exception to DR-005).
- DR-043: a shell into a service that mounts secrets needs `secrets.read` as well as
  `terminal.open`, and those recordings are encrypted at rest.

## Which skill to load

| You're touching                                         | Skill                                       |
| ------------------------------------------------------- | ------------------------------------------- |
| `apps/app` screens and components                       | `hot-signal-design`, `react-components`     |
| `packages/ui`, `apps/web`                               | `design-reference`                          |
| A feature across db, protocol, tRPC and UI              | `add-feature-slice` (an epic: `start-epic`) |
| `apps/agent`, `packages/core/src/protocol`, the gateway | `agent-handlers`                            |
| Agent CLI, doctor, install repair, recovery claims      | `node-recovery`                             |
| Where a piece of config or state lives                  | `docker-native-storage`                     |
| A controller reconcile or scheduler worker              | `reconcile-workers`                         |
| Auth, ABAC, audit, admission, identity routers          | `auth-abac`                                 |
| Backups, restores, drills, controller backup            | `backups-dr`                                |
| Builds, registry, image GC, previews                    | `cicd-registry`                             |
| Geo-DNS, swarmy-dns, region-aware Caddy                 | `geo-edge-routing`                          |
| A new ingress driver                                    | `scaffold-ingress-driver`                   |
| Postgres, caches, search, vectors, buckets              | `managed-data-services`                     |
| The WireGuard mesh and people access                    | `mesh-networking`                           |
| Telemetry, alerts, incidents, status pages              | `observability-otel`                        |
| REST API, SDKs, Terraform provider                      | `rest-api-surface`                          |
| A new package or app in the monorepo                    | `new-workspace`                             |
| Running it locally                                      | `run-local`                                 |
| Tests and CI gates                                      | `testing-conventions`                       |

## Commands

- `bun run typecheck`, `bun run test`, `bun run build`
- `bun run db:check` after a schema change; `bun run db:migration <name>` to add one
- `bun run scripts/records.ts check`; `bun run scripts/records.ts index` after adding a record

## Pull requests

- The PR title is a Conventional Commit with a scope from `commitlint.config.mjs`;
  squash-merge makes it the release note.
- Every commit is signed off (`git commit -s`, DCO) and cites records in a trailer,
  for example `Refs: BR-037, DR-046`.
- `docs/decisions/` and `docs/requirements/` need the founder's review.
