# Governance & access — "every mutation org-scoped, policy-checked, and on the record"

**Status: canonical product design (2026-07). Pairs with the `auth-abac`
skill for the how.**

## The feeling we are building

Someone running a team on swarmy should never wonder *who can do what*, *what
production will let them ship*, or *what actually happened*. The answer is
always one of three screens, and all three read like plain English:

1. They open **Settings → Access** ("Run the team.") and see the org, its
   members, and the join tokens that let nodes into the swarm. A member gets a
   role; a role is just a starting point, not a ceiling — they can hand one
   member `operator` on a single stack without making them an admin.
2. They open **Governance → Guardrails** ("Production is locked down.") and flip
   **Production safety mode** — one switch. Now any stack marked production
   refuses a deploy that floats `:latest`, skips a healthcheck, runs privileged,
   binds a host port, or ships a database with no backup and no replicas. The
   deploy dialog says exactly which rule bit and why.
3. Someone tries to ship anyway. A **warn** asks them to confirm; a **block**
   refuses outright and only an admin can override. Either way the attempt, the
   reasons, and the override land in **Recent decisions** — the audit trail,
   shown right there under the rules that produced it.
4. Months later they open **Audit** and ask "who scaled checkout at 2am?" The row
   is there: actor, action, target, and the policy that permitted it. Nothing
   mutating happens on swarmy — by a person, an API key, or a background worker —
   without a row.

No cross-org leakage to reason about. No "prod" flag in a database swarmy must
keep honest. No role matrix to memorise. It should feel like the platform is
**quietly keeping the receipts and holding the line** — invisible until you use
it, unarguable once you do.

## How it works (the procedure chain)

```
tRPC call
   │  publicProcedure ─────────────────── unauthenticated (sign-in, public status)
   ▼
protectedProcedure   ① session + user or UNAUTHORIZED
   ▼
orgProcedure         ② activeOrgId set AND caller is a Member of it
   │                    → ctx.membership { role, orgId }; every query is where:{orgId}
   ▼
adminProcedure       ③ coarse gate: role !== 'member'   (non-destructive governance)
   │
   └─ abacProcedure(action, resolveResource)   ④ fine gate: build P·A·R·C,
        │   evaluate org policies (forbid-wins, default-deny),
        │   throw FORBIDDEN{ swarmyCode:'POLICY_DENIED', policyId } on deny
        ▼
      resolver runs → writeAudit(permit) → mutation
                        every deny ALSO writes an audit row
```

Four ideas, one story:

- **The org boundary is the hard wall; ABAC operates inside it.** `orgProcedure`
  proves membership and pins `ctx.activeOrgId`; every downstream query filters
  `where: { orgId }`. Cross-org data is not a policy question — it is structurally
  impossible. Policies never widen the tenant boundary, only narrow within it.
- **Roles are an attribute, not the gate.** The principal carries
  `{ userId, orgId, role, memberId, teamIds, attributes }` from the `Member` row.
  The *seeded* default policy set reproduces today's `owner`/`admin`/`member`
  semantics exactly — an org that never opens the policy UI behaves precisely as
  it always did. ABAC is additive: behaviour only diverges when an admin writes a
  custom policy or grants a per-resource relation.
- **Every mutation is admitted, then recorded.** Deploy-shaped mutations pass the
  **admission pipeline** (guardrails + exposure + images) before touching the
  swarm; all mutations pass `writeAudit`. The permit records the deciding policy;
  the deny records the reasons. There is exactly one audit writer.
- **Docker owns "what is production"; the DB owns the rules and the record.** A
  stack is production because its services carry `swarmy.env=production` (a label,
  Docker truth), not because a column says so. See the `docker-native-storage`
  skill.

## Roles and where truth lives

- **"Which stack is production" is a Docker node/service label**
  (`swarmy.env=production`, stamped on every service of the stack via
  `service.updateLabels`, read from live inventory). The guardrails evaluator
  detects prod from live labels *or* the incoming specs, so a deploy that stamps
  the label counts as prod immediately. No `Stack.isProduction` column to drift.
- **Per-node cost is a label on the node** (`swarmy.node.cost` — "swarmy stores
  it on the node itself"), so the Cost page's per-stack breakdown survives with
  zero cost-specific DB rows. Same Docker-truth rule as roles/region.
- **Resource labels feed attribute policies.** Node and service labels come from
  the live hub (there is no `Node.labels` column), so a policy like "members may
  restart only services labelled `tier=web`" reads Docker truth at decision time.
- **What the DB owns is only swarmy's own access & record**: `Member`
  (role + free-form `attributes` bag), `Policy` (the org's policy documents),
  `ResourceGrant` (ReBAC edges), `GuardrailConfig` / `ExposureConfig` (rule
  toggles + the master switches), identity rows (`Organization`, `SsoProvider`,
  `AuthProviderConfig`, `OAuthClient`, `ApiKey`, `JoinToken`), and the append-only
  `AuditLog`. Everything about *the swarm* is derived from Docker.

## Governance behaviour (what the promise commits us to)

- **One decision path.** Coarse membership (`orgProcedure`/`adminProcedure`) and
  fine policy (`abacProcedure`) compose; a policy engine evaluates the same
  P·A·R·C request the same way every time. The default engine is a zero-dependency
  JSON-predicate evaluator (sub-millisecond); Cedar (`@cedar-policy/cedar-wasm`)
  is an optional, behaviour-faithful drop-in that falls back to the JSON engine if
  absent or misbehaving. Users never see which engine ran.
- **Forbid-wins, default-deny.** Among matching policies any `forbid` beats every
  `permit`; with no matching permit the answer is deny. Highest-priority match is
  what gets recorded, so the audit row names a real reason.
- **ReBAC without a graph database.** A `ResourceGrant` gives a member or team a
  relation (`owner` ⊇ `operator` ⊇ `viewer`) on one resource; the seeded
  `operator-resource-ops` policy lets an operator run safe ops on *that* resource
  without org-wide rights (production included). Behaviour-neutral for orgs with
  no grants.
- **Rules are attribute-based and read as sentences.** (Owner direction
  2026-09-24: "members: more attribute-based permissions".) A rule is WHO ×
  CAN × WHERE. WHO is a role, a **group** (`Member.attributes.groups` set by an
  admin ∪ `attributes.ssoGroups` written from IdP group claims on each SSO login
  ∪ team ids), named members, or any member attribute. WHERE is the resource's
  attributes: `resource.env` (the `swarmy.env` label, `prod`/`prd`/`live`
  normalised to `production`; unset = non-production), `resource.type`, and any
  Docker label (`resource.label.team`). The editor renders each rule as
  "Members of platform can deploy apps on apps where env is production." and a
  **who-can** simulator lists every member's decision and the deciding rule for
  an action on a real or hypothetical resource. Policies are stored behind a
  `PolicyRepository` so they can move off Postgres without touching the gate.
- **Members deploy freely outside production.** The seeded defaults: owners and
  admins everything; members read everything and deploy, configure, scale and
  restart anything that is not production. A production deploy, every
  destructive action, `terminal.open`, `secrets.read` and `mesh.connect` need an
  explicit grant — a group/member rule or a `ResourceGrant`. A stack's env is its
  live services' labels (production if any is), or for a brand-new stack the
  labels its compose stamps, so "deploy it straight to prod" can't dodge the gate.
  Orgs whose defaults were persisted as rows before this keep them (opening the
  policy page tops up new default rules additively); **Reset defaults** re-seeds.
- **Guardrails are per-rule, prod-aware, and overridable on the record.** Each
  rule is `block` or `warn`. A **warn** surfaces in the deploy dialog and any
  member may confirm through it; a **block** refuses and only an admin may
  override. **Production safety mode** forces every rule to `block` on production
  stacks (per-rule params still apply); prod-scoped rules stay silent everywhere
  else. Every block and every override is an `AuditLog` row — the Recent decisions
  feed is literally a query over them.
- **Guardrails defer, they don't duplicate.** `requireSignedImagesProd` emits
  nothing when the registry policy already enforces cosign signatures — the image
  evaluator does the real verify. One check, one owner.
- **Identity is pluggable and off by default.** Email+password and the
  `organization` plugin are always on; social/OIDC SSO, magic-link, and passkeys
  are runtime-built from `AuthProviderConfig` and only appear on the sign-in page
  when enabled. API keys and OAuth clients are admin-minted, hashed at rest, and
  scoped — see the `rest-api-surface` skill.

- **Every destructive action runs the policy gate — on both front doors.**
  (Owner decision 2026-09-24.) Removing, destroying, restoring over, draining,
  revoking or failing over is `abacProcedure(action, resolver)` in tRPC and
  `requireAction(action, resolver)` on the REST route that calls the same
  service; both call one `authorize` step, so a dashboard click and an API-key
  call get the identical decision and the identical `authz.permit|deny:<action>`
  audit row. The governed actions:

  | Action | Covers |
  |---|---|
  | `service.remove` / `stack.remove` / `node.remove` | removing a service, a stack or preview env, a node |
  | `service.scale` / `service.restart` / `node.drain` | scale (incl. to 0), restart, drain/cordon |
  | `data.destroy` | managed cache/search/vector/queue teardown or drain, bucket/key delete, object store disable, cluster-volume deregister |
  | `data.restore` | volume, DB, cache, search, controller and offsite-mirror restores (they overwrite live data) |
  | `data.failover` | confirming a managed-DB failover that may lose the last writes (see `managed-data.md`) |
  | `backup.remove` | removing a backup target or the offsite mirror |
  | `secret.delete` | deleting or pruning a secret/config family |
  | `dns.remove` / `ingress.remove` / `ingress.write` | geo-DNS zone/record removal; Cloudflare tunnel delete; domain removal |
  | `token.revoke` / `member.write` / `policy.write` / `authconfig.write` / `cicd.remove` | API key / OAuth client / join token / direct-connect revoke; grants + invitations; policy, SSO and git-repo removal |
  | `service.deploy` / `stack.deploy` / `service.configure` | create a service, deploy/redeploy a compose stack, add an app to a stack, connect apps; edit a service or its scale-to-zero (env-aware, see above) |
  | `secrets.read` | revealing the swarm unlock key or a git webhook secret |
  | `mesh.connect` | joining an app stack's mesh network from a client (group sync reads `whoCan`) |

  **Seeded defaults: owners and admins can do all of it (no lockout, even for an
  org whose defaults were persisted before these actions existed — their `*`
  permits cover them); members keep drain, scale, restart and domain removal (outside
  production) and are refused the rest.** That is a deliberate tightening for members on
  service/stack/preview removal, managed-data destroy/restore and queue
  remove/drain, which were member-callable before; an org re-grants any of them
  with one policy. Over REST it also closes the gap where a member's API key
  could remove a node. Not yet swept (config-level deletes, still
  role-gated): alert channels/rules, notification templates, status pages,
  inbound/outbound webhooks, jobs, workflows, backup schedules, AI-gateway keys.

- **The web terminal is one policy gate and a dumb pipe.** tRPC `terminal.open`
  is the only gate (ABAC `terminal.open` + `TerminalPolicy` + optional four-eyes
  approval + audit) and mints a 30 s single-use ticket; `/term/ws` only checks
  the ticket and session cookie, then pipes bytes. The PTY tunnels over the
  agent's dial-out WebSocket rather than proxying SSH — SSH would add a second
  credential system and make recording impossible. Recording is controller-side
  asciicast, output only (input is never recorded); mandatory for node shell,
  org-toggleable for container exec. Container exec is on by default; node shell
  (root on the host) is off until an admin sets `swarmy.node.shell=true`, and a
  node can veto either locally (see `agent-handlers` invariant 10). Known gap:
  `requireMfa` and `maxSessionMs` are stored but not yet enforced.

## Failure modes (designed, not accidental)

| Failure | Behaviour |
|---|---|
| Caller is not a member of the active org | `orgProcedure` throws `FORBIDDEN` before any resolver or query runs — the tenant wall, not a policy decision. |
| No stored policies for the org | The engine loads the seeded defaults verbatim; behaviour is exactly today's role model. The gate can never be *empty*. |
| Stored `rulesJson` is malformed / has unknown ids | Parsed over the defaults; bad entries dropped, missing rules fall back. A corrupt config can never brick admission. |
| Cedar (`cedar-wasm`) absent or throws at runtime | Transparent fallback to the JSON engine; the decision is identical for the supported document shape. |
| Audit write fails (DB hiccup) | `writeAudit` swallows the error — a logging failure never rolls back or blocks the underlying mutation. |
| A `block` guardrail fires on a prod deploy | The deploy is refused with the exact rule + plain-words reason; an admin may override, and the block *and* the override are both audited. |
| System actor (worker/webhook/GC) mutates | It writes an `AuditLog` row with `actorType:'system'` — automation is on the record exactly like a human. |

## Explicitly rejected

- **A `production` boolean column on Stack.** It drifts from swarm truth the
  moment someone re-labels a service. Prod is the `swarmy.env` label, read live —
  see `docker-native-storage`.
- **Roles as the authorization gate.** A fixed `owner/admin/member` matrix can't
  express "operator on *this* stack" or "members may restart only `tier=web`".
  Roles become one attribute among many; the policy engine is the gate.
- **A second, separate audit path for background jobs.** One `writeAudit` writer,
  `actorType` distinguishes user/apikey/system/agent. Two writers means one of
  them eventually forgets a row.
- **An external IdP (Keycloak/Authentik/Ory) in front, or a Better Auth
  instance per org.** A heavy stateful service breaks one-command install;
  existing IdPs plug in as SSO providers instead.
- **Deriving the public API from tRPC (`trpc-openapi`) or exposing GraphQL.**
  Either couples the public contract to the internal router shape; Terraform
  and curl want plain resourceful REST. The hand-authored `@hono/zod-openapi`
  route registry is the only sanctioned path (see `rest-api-surface`).
- **A Zanzibar-scale relationship store (SpiceDB/OpenFGA) or an OPA sidecar.**
  Overkill and an extra network hop in the auth path. Cedar's entity-parent ReBAC
  plus a handful of `ResourceGrant` edges covers "an org's nodes/stacks/services."
- **Silently dropping the audit on deny.** A denied request is the most valuable
  security signal there is; `abacProcedure` audits *every* deny, not just permits.
- **Removing an exposure/guardrail violation automatically.** swarmy alerts and
  refuses new violating deploys, but never edits your running swarm out from under
  you — "the fix is always yours to make."

## Implementation map

The invariants and file map live in the `auth-abac` skill
(`.claude/skills/auth-abac/SKILL.md`) — the procedure chain, the P·A·R·C engine,
the admission pipeline, and the one audit writer. Key homes:
`packages/trpc/src/trpc.ts` (`publicProcedure`→`protectedProcedure`→
`orgProcedure`→`adminProcedure`), `packages/trpc/src/abac.ts` (`abacProcedure`,
`evaluateAccess`, resolvers), `packages/abac/src/*` (the engine, defaults,
grants, Cedar adapter), `packages/trpc/src/services/audit.service.ts`
(`writeAudit`), `packages/trpc/src/services/admission*.ts` (spine + guardrails/
exposure/images evaluators), `packages/trpc/src/services/guardrails.service.ts`
(config + Recent decisions), the identity routers under
`packages/trpc/src/routers/*`, the Prisma models in
`packages/db/prisma/schema/{access,governance,api,auth,cluster}.prisma`, and the
UI at `apps/app/src/routes/_authed/{governance,exposure,settings_.access,audit,cost}.tsx`.
Adding a governed mutation follows the `add-feature-slice` skill; the exposure
half of the admission story pairs with the ingress-and-exposure doc.
