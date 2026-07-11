---
name: auth-abac
description: Invariants, contracts, and file map for swarmy's security model — the publicProcedure→protectedProcedure→orgProcedure→adminProcedure chain, the abacProcedure P·A·R·C policy seam (@swarmy/abac JSON/Cedar engine + ResourceGrant ReBAC), the single writeAudit writer, and the deploy admission pipeline (guardrails/exposure/images). Load before touching packages/trpc/src/{trpc,abac}.ts, packages/abac, packages/auth, the audit/admission/guardrails services, the identity routers (org/members/policies/sso/oauth/authConfig/apiKeys/guardrails/cost/auditLog), or schema/{access,governance,api,auth}.prisma. Product rationale lives in docs/product/governance-and-access.md.
---

# Auth & ABAC: the org wall, the policy seam, and the audit trail

Read `docs/product/governance-and-access.md` for WHY every mutation is
org-scoped, policy-checked, and recorded. This skill is the HOW: the invariants
every change to the security model must keep, and where everything lives. To
wire a governed mutation across the stack (db → protocol → service → router → UI)
see `skill("add-feature-slice")`; this skill owns the authz/audit third of it.

## Invariants (violating any of these is a bug, not a style choice)

1. **The org boundary is the hard tenant wall; ABAC operates *within* it.**
   Every data query on an org-scoped table filters `where: { orgId:
   ctx.activeOrgId }`. `orgProcedure` proves membership and pins `activeOrgId`
   before any resolver runs. Policies may narrow access inside an org; they never
   widen it across orgs. There is no cross-org read, ever — that is structure,
   not a policy decision.
2. **The procedure chain is fixed and additive:**
   `publicProcedure → protectedProcedure` (session+user or `UNAUTHORIZED`)
   `→ orgProcedure` (member of `activeOrgId`, sets `ctx.membership {role, orgId}`)
   `→ adminProcedure` (coarse: `role !== 'member'`) and
   `→ abacProcedure(action, resolveResource)` (fine: P·A·R·C policy eval), both
   built on `orgProcedure`. Never author a mutating procedure below
   `protectedProcedure`; never reach past `orgProcedure` for org data.
3. **Roles are an attribute, not the gate.** The principal is
   `{ userId, orgId, role, memberId, teamIds, attributes }` from the `Member`
   row. The gate is the policy engine. Do not add role-name `if`-checks in
   resolvers to authorize; add or adjust a policy.
4. **No stored policies ⇒ seeded defaults, verbatim.** `loadEngine` falls back to
   `defaultPolicyInputs()` when the org has zero enabled `Policy` rows, so an org
   that never opens the policy UI behaves exactly as the `owner/admin/member`
   model always did. The gate is never *empty* and never *default-permit*.
5. **Forbid-wins, default-deny.** Among matching policies any `forbid` overrides
   every `permit`; no matching permit ⇒ deny. The deciding (highest-priority)
   policy id is reported so the audit row names a real reason. Both engines
   (`JsonPolicyEngine`, `CedarPolicyEngine`) MUST produce identical decisions for
   the supported document shape — `packages/abac`'s unit tests are a CI gate (see
   `skill("testing-conventions")`).
6. **The engine is swappable behind `createEngine`; `abacProcedure` depends only
   on `IPolicyEngine`.** Cedar is optional (`@cedar-policy/cedar-wasm`, dynamic
   import); if absent or it throws at runtime, `tryCreateCedarEngine` returns
   `null` / the Cedar path falls through to the JSON engine. Never make Cedar a
   hard dependency or let a missing WASM module break authorization.
7. **`writeAudit` is the single audit writer, and it is best-effort.** Every
   mutating path — including `system`/`agent`-actor automation (workers,
   webhooks, GC, schedulers) — records exactly one row via `writeAudit`. An audit
   failure is swallowed and MUST NOT roll back or block the mutation. Do not open
   a second audit path; `actorType` (`user|apikey|system|agent`) distinguishes the
   source.
8. **`abacProcedure` audits every deny AND every permit.** A denied request is a
   security signal — never drop it silently. Deny throws `FORBIDDEN` with
   `cause: { swarmyCode: 'POLICY_DENIED', policyId }`; the UI branches on
   `swarmyCode`.
9. **Deploy-shaped mutations pass the admission pipeline before the swarm.**
   Build an `AdmissionIntent` and call `evaluateAdmission`; refuse when any
   `block` violation returns unless `intent.override` is set (and audit the
   override with `stack.deploy.override` / `service.deploy.override`). The
   spine's shape (`admission.service.ts`) is a contract — add rules inside an
   evaluator, never change the spine's fan-out.
10. **"Production" is the `swarmy.env=production` Docker label, never a DB
    column.** Guardrail prod-detection reads it from live inventory or the
    incoming specs. Config rows (`GuardrailConfig`, `ExposureConfig`) hold only
    rule toggles + the master switch; the blocked/overridden feed is a query over
    `AuditLog`. Reaching for a new state column? Stop — see
    `skill("docker-native-storage")`.

## Contracts between the layers

- **Enforcement seam**: `abacProcedure(action, resolveResource?)` (built on
  `orgProcedure`) → `evaluateAccess(ctx, action, resourceInput)` →
  `buildPrincipal` + `loadEngine` + (if a resource) `loadGrants` +
  `buildResource` → `engine.evaluate(P·A·R·C)` → `{ decision, policyId, reasons,
  resource }`. Reuse `evaluateAccess` for the policy simulator and list-filtering
  so there is one decision path. `action` must be a member of `ACTIONS`
  (`@swarmy/abac`); `isAction` guards at wiring time.
- **Resource resolvers** map a procedure's input → a `ResourceInput`
  `{ type, id, orgId, labels }`, or `null` for collection/instance actions (the
  resource is the org itself). Reuse `resolveNode`/`resolveService`/`resolveStack`
  from `abac.ts`; node/service labels come from the **live hub**, not a DB column.
- **ReBAC**: `ResourceGrant` edges (`principalType member|team`, `resourceType`,
  `resourceId`, `relation owner|operator|viewer`) are loaded per-resource;
  `resolveRelations` applies the implication `owner ⊇ operator ⊇ viewer`. The
  seeded `operator-resource-ops` policy grants safe ops on a granted resource.
- **Admission spine**: `evaluateAdmission(ctx, intent)` fans out to
  `admission-exposure`, `admission-guardrails`, `admission-images` and flattens
  `Violation[]` (`{ rule, severity: 'block'|'warn', message, resource? }`).
  Guardrails defers to the registry image policy for signatures
  (`requireSignedImagesProd` emits nothing when `RegistryConfig.requireSignedImages`).
- **Audit shape**: `writeAudit(ctx, { action, targetType?, targetId?, actorType?,
  actorId?, metadata? })`. `action` is a stable dotted string
  (`authz.permit:service.restart`, `guardrails.deploy.blocked`,
  `guardrails.safetyMode.set`). The Recent-decisions feed reads
  `DECISION_ACTIONS`.
- **Identity**: `@swarmy/auth` wraps Better Auth (`organization` plugin always
  present as element 0; social/OIDC-SSO/magic-link/passkey injected at runtime
  from `AuthProviderConfig`). API keys/OAuth clients are hashed at rest and
  scoped — see `skill("rest-api-surface")`.

## File map

| Concern | Where |
|---|---|
| Procedure chain (`public→protected→org→admin`) | `packages/trpc/src/trpc.ts` |
| `abacProcedure`, `evaluateAccess`, resolvers | `packages/trpc/src/abac.ts` |
| Request context (`OrgContext`, `activeOrgId`, hub) | `packages/trpc/src/context.ts`, `apiKeyContext.ts` |
| Policy engine (`IPolicyEngine`, JSON default) | `packages/abac/src/engine.ts` |
| Cedar adapter (optional, faithful fallback) | `packages/abac/src/cedar.ts`, `factory.ts` (`createEngine`) |
| Policy document parse/match + P·A·R·C types | `packages/abac/src/{policy,types}.ts` |
| Seeded default policy set | `packages/abac/src/defaults.ts` |
| Principal/resource/grant builders + relation implication | `packages/abac/src/{build,grants}.ts` |
| The one audit writer | `packages/trpc/src/services/audit.service.ts` |
| Admission spine + evaluators | `packages/trpc/src/services/admission{.service,-guardrails,-exposure,-images}.ts` |
| Guardrails config + Recent decisions | `packages/trpc/src/services/guardrails.service.ts` |
| Identity / access routers | `packages/trpc/src/routers/{org,members,policies,sso,oauth,authConfig,apiKeys,guardrails,cost,auditLog}.ts` |
| Better Auth wiring (runtime-built) | `packages/auth/src/{server,config,client}.ts` |
| Access & auth models | `packages/db/prisma/schema/access.prisma` (`Policy`, `ResourceGrant`, `SsoProvider`, `AuthProviderConfig`) |
| Governance config + identity + audit models | `packages/db/prisma/schema/{governance,api,auth}.prisma`; `AuditLog`/`JoinToken` in `cluster.prisma` |
| UI surfaces | `apps/app/src/routes/_authed/{governance,exposure,settings.access,audit,cost}.tsx` |

## Recipe: put a mutation behind a policy + audit it

1. **Pick the action** from `ACTIONS` in `packages/abac/src/types.ts` (add a new
   action there + to the seeded defaults if none fits). `isAction` will reject
   typos at wiring time.
2. **Swap the procedure**: `orgProcedure` → `abacProcedure('service.restart',
   resolveService)` (define a resolver next to the router if the row isn't one of
   the shared three). Do NOT heavily edit other epics' routers — the swap is
   one line.
3. **Let the seam audit authz**: `abacProcedure` already writes
   `authz.permit:*` / `authz.deny:*`. Add a domain `writeAudit` in the *service*
   for the business event (`guardrails.rule.set`), with `actorType:'system'` for
   worker-invoked paths.
4. **If it deploys**, build an `AdmissionIntent`, call `evaluateAdmission`, refuse
   on `block` unless `override`, and audit the override. New rules go *inside* an
   evaluator, keeping the spine fan-out unchanged.
5. **Verify**: `bun --filter @swarmy/abac test` (engine parity + policy units) and
   `bun --filter @swarmy/trpc typecheck`. Policy behaviour is a CI gate; a new
   default policy or action must ship with a unit — see
   `skill("testing-conventions")`.

## Operational gotchas

- The seeded defaults are **behaviour-preserving on purpose** — changing one
  silently changes every org that never wrote a custom policy. Treat
  `defaults.ts` edits as breaking and cover them with a unit.
- `abacProcedure` runs `resolveResource` on `opts.input`; a resolver that returns
  `null` evaluates against the org (collection/instance scope). Returning `null`
  for a *missing* row means the policy sees "no resource," not "denied" — enforce
  existence in the resolver's org-scoped `findFirst`.
- Guardrail `warn` vs `block` is a product distinction the deploy UI enforces
  (any member confirms a warn; only an admin overrides a block); the spine itself
  only refuses on `block`. Keep the override audited on both paths.
- Never log secrets in `metadata`. Audit rows are org-readable; the encrypted
  secret columns (`AuthProviderConfig.encryptedSecret`, `WebhookEndpoint.secret`)
  stay in the DB, never in an `AuditLog`.
- `AuditLog.id` is a `BigInt` — stringify it at the router boundary (the feed
  services already do) so JSON serialization stays lossless.
