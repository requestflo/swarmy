# Guardrails are completely bypassed by the "Ship a service" quick-deploy path — a `:latest` image deploys straight into an armed, forced-to-block production stack with zero warning and zero audit trail

**Status:** Fixed (2026-09) — `createService` and every other user-image deploy path now run the
admission spine + write an audit row; see "Fix applied (2026-09)" below.
**Severity:** Critical — this is the platform's core production-safety promise ("Production is
locked down... Violating deploys are refused; every block and override is on the record") and it
does not hold for one of the two ways to deploy a service. A user who reads that promise and trusts
it will be silently unprotected the moment they use "Ship a service" instead of a full stack/compose
deploy.

## Symptom

Live, end-to-end reproduction entirely through the real product UI (no SSH, no API shortcuts):

1. Governance → Guardrails: armed the master "Production safety mode" switch — confirmed via toast
   and UI state "Production is locked down" / "ARMED".
2. "No :latest images in production" rule: effect=Block, individually toggled on, showing a "forced
   block in prod" badge from the master switch.
3. Environments panel → marked the `apitest` stack production via the real "Mark production" button
   — confirmed via toast "apitest is now production" and the UI tagging `apitest` "production" with
   an "Unmark" button.
4. Deploy → "Ship a service" (`/services/new`) → Name=`sweep-latest-violation`,
   Image=`nginx:latest` (explicit, unambiguous `:latest` tag), Project=`apitest` (the exact stack
   just marked production), everything else left default → clicked Deploy.
5. **The deploy succeeded fully and visibly.** No error, no block, no warning toast. Navigated
   straight to the new service's detail page showing "sweep-latest-violation is converging", then
   genuine live container logs of nginx actually starting up (`docker-entrypoint.sh` boot lines,
   "using the epoll event method", etc.) — a real, successful violation of an armed Block rule.
6. Governance → Guardrails → "Recent decisions" panel: still read "Nothing blocked or overridden
   yet — deploys that hit a guardrail land here." No record of this deploy at all, in either
   direction.
7. Cross-checked against Governance → Audit log → "Who deployed?" quick filter (scoped to
   "Stack/service deploys, CI autodeploys, rollbacks"): the `sweep-latest-violation` deploy does
   not appear there either, despite happening well within the visible time window (the two entries
   shown were both from 9h earlier — an unrelated `release.gate.failed`/`stack.deploy` pair). The
   quick-deploy path isn't just invisible to the guardrails decision log — it writes **no audit
   entry of any kind**, not even a benign "service created" record. For a feature whose own page
   copy promises "every action across the org... recorded the moment it happens," this is a second,
   independent compliance gap stemming from the same missing-integration root cause (see below).

## Root cause

The "Ship a service" quick-deploy mutation never calls the governance/admission pipeline at all —
it isn't wired in, correctly, buggily, or otherwise.

- `apps/app/src/routes/_authed/services/new.tsx:43-55` — the form calls
  `trpc.services.create.mutationOptions(...)`.
- `packages/trpc/src/routers/services.ts:48` —
  `create: orgProcedure.input(CreateServiceInput).mutation(({ ctx, input }) => createService(ctx, input))`.
- `packages/trpc/src/services/service.service.ts:159-192` (`createService`) — builds a
  `ServiceSpec` (`buildServiceSpec`, lines 26-63) and dispatches straight to
  `ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' })` at line 177. This
  file never imports `evaluateAdmission`, `admission.service`, `admission-guardrails`, or
  `writeAudit` — the only other side effect is a best-effort outbound webhook (lines 185-190),
  unrelated to governance.

The guardrail engine itself is not the problem — it works correctly when actually invoked:

- `packages/trpc/src/services/admission-guardrails.ts` — `decideGuardrails()` (lines 158-274)
  contains the `noLatestTagInProd` rule (lines 169-180), and `isLatestImage()` (lines 105-112)
  correctly handles both a bare tag and an explicit `:latest` — this specific check is not buggy.
  `effectiveRules()` (lines 127-139) correctly forces every rule to `block` when
  `productionSafetyMode` is on. `evaluate()` (lines 278-379) determines production status by
  reading the live Docker label `swarmy.env=production` off the target stack's services (lines
  285-300) — and explicitly declares support for `intent.kind === 'service.deploy'`, i.e. the
  evaluator is fully capable of covering exactly this kind of ad-hoc single-service deploy.
- `packages/trpc/src/services/guardrails.service.ts:214-244` (`setStackEnv`, backing "Mark
  production") correctly stamps `swarmy.env=production` via `service.updateLabels` onto every live
  service in the stack, and correctly writes a `guardrails.stackEnv.set` audit row. Confirmed
  working — not the bug.
- `evaluateAdmission()` (`admission.service.ts`) is the single chokepoint everything is supposed to
  funnel through, fanning out to `evaluateGuardrails`/`evaluateExposure`/`evaluateImages`. Confirmed
  called correctly from exactly two places:
  - `packages/trpc/src/services/stack.service.ts:187-210` (`deployFromCompose`) — the full
    stack/compose YAML deploy path. Throws `admissionDenied()` on block, requires admin override,
    writes a `stack.deploy.override` audit row on override.
  - `packages/trpc/src/services/releases.service.ts:815-824` (`startCanary`) — even the canary
    deploy path calls it, with an explicit code comment: "A canary is a service deploy — the
    admission pipeline still applies" (line 814).

  `createService` — the mutation backing `/services/new` — is the one deploy-shaped code path that
  is not in this list.

- The audit trail is a direct consequence of the same gap:
  `recentDecisions()` (`guardrails.service.ts:278-304`) reads `AuditLog` rows with actions
  `['guardrails.deploy.blocked', 'stack.deploy.override', 'service.deploy.override']`
  (`DECISION_ACTIONS`, lines 249-253). The only writer of `guardrails.deploy.blocked` is inside
  `evaluate()` at `admission-guardrails.ts:365-376` — never reached from `createService`. So "Recent
  decisions" is empty because governance evaluation never ran for this deploy, not because it ran
  and silently permitted the violation.

## Why this matters

This is not a rare edge case or a misconfiguration — it fails identically for every org, every
deploy, every time, because the gap is structural: one of the two user-facing ways to deploy a
service was simply never connected to the governance layer at all, unlike the other one (full
stack/compose) and even the more exotic canary-release path, both of which *do* correctly enforce
it. Anyone using "Ship a service" — likely the more common path for a single ad-hoc container,
given the whole pitch of swarmy is ease of single-command deploys — gets zero protection from
Production safety mode, Image policy, or exposure guardrails, with a dashboard that actively claims
otherwise ("Production is locked down... every block and override is on the record").

## Suggested fix direction

Add an `evaluateAdmission(ctx, { kind: 'service.deploy', orgId, stackName: input.project, specs: [spec] })`
call into `createService` (`service.service.ts`, before line 177's `ctx.hub.dispatch(...)`),
mirroring exactly how `startCanary` (`releases.service.ts:815-824`) already does it — including the
same block/override/audit handling `deployFromCompose` and `startCanary` both use. Given the
evaluator already explicitly supports `service.deploy` as an intent kind, this should be a
straightforward integration, not new logic.

Add a regression test that deploys a `:latest` image via `createService` directly (bypassing the UI)
against a stack with `swarmy.env=production` set and `productionSafetyMode` on, asserting it throws
`admissionDenied()` — the same shape of test this sweep would expect to already exist for
`deployFromCompose` (not confirmed either way whether one does).

## Not yet tested

Whether the same gap exists in any other deploy-shaped mutation beyond `createService`,
`deployFromCompose`, and `startCanary` — not exhaustively enumerated. Whether "Image policy"
("Only deploy signed images") and "Exposure" guardrails (as opposed to the "No :latest" rule
specifically tested here) are subject to the identical bypass via this same code path — very likely
given `evaluateAdmission` is the single shared chokepoint for all three, but not independently
reproduced per-rule this session.

## Fix applied (2026-09)

**Shared gate.** New `packages/trpc/src/services/admission-gate.ts` — `enforceAdmission(ctx, intent,
{targetType, targetId, mode})` + `admissionDenied()` (moved out of `stack.service.ts`). It wraps the
unchanged `evaluateAdmission` spine with the exact semantics `deployFromCompose` already had:
any violation without `override` → `PRECONDITION_FAILED` / `swarmyCode: POLICY_DENIED` (guardrails
evaluator records `guardrails.deploy.blocked` → "Recent decisions"); a `block` override by a
`member` → `FORBIDDEN`; a permitted override → one `stack.deploy.override` / `service.deploy.override`
audit row. `mode: 'automation'` (webhooks/workers — nobody can override) refuses only on `block`.
`deployFromCompose` now calls it (behaviour identical).

**`createService` (this issue)** — `service.service.ts:182` runs `enforceAdmission({kind:
'service.deploy', stackName: input.project, specs: [spec], override})` before dispatch, and
`:203` writes a `service.deploy` audit row (shows in "Who deployed?"). `CreateServiceInput` gained
an optional `override` (`packages/core/src/inputs.ts:67`); `UpdateServiceInput` inherits it.

**Other gaps found and fixed in the same sweep**

| Path | Was | Now |
|---|---|---|
| `updateService` (`services.update`) | no admission, no audit; rebuilt labels from scratch, **stripping `swarmy.env=production`** (update silently took a service out of guardrail scope) | live labels carried forward (`service.service.ts:265`), admission `:268`, `service.deploy` audit `:287` |
| `addServiceToStack` (`stacks.addServiceToStack`, "Add app" dialog) | no admission, no audit | admission `stack.service.ts:305`, `service.deploy` audit `:328` |
| `deployFromModel` (`builder.deploy`, GUI builder) | audit only | admission `builder.service.ts:108` |
| `autodeployBuilt` (CI autodeploy) | audit only | admission (automation) `cicd.service.ts:323`; a block skips the redeploy (build still succeeds) and writes `cicd.autodeploy.blocked` |
| `handlePrEvent` (PR previews, webhook + manual) | audit only | admission (automation) `previews.service.ts:462`; a block refuses and writes `previews.deploy.blocked` |
| tRPC `stacks.deployFromCompose` / `stacks.redeploy` / `stacks.addServiceToStack` / `builder.deploy` | zod input stripped `override` — the override path was unreachable from the dashboard | `override` accepted (`routers/stacks.ts:23,47,53`, `routers/builder.ts:32`) |
| `scaleService` / `restartService` / `removeService` | no audit | `service.scale` / `service.restart` / `service.remove` audit rows (no admission — they change no admitted fact) |

**Already correct (verified):** `deployFromCompose`, `redeployStack` → `deployFromCompose`,
`rollbackTo` → `deployFromCompose` (+ `release.rollback`), blueprints `stack.deploy` step →
`deployFromCompose`, `deployTemplate` → `deployFromCompose` (+ `templates.deploy`), `startCanary`
(own block-only refusal + `release.canary.start`), `promoteCanary` (image already admitted at start).
REST `POST /stacks` → `deployFromCompose`; REST `POST /services` → `createService` (now gated).

**Intentionally not gated (platform-owned images / same-image re-rolls):** managed db/cache/search/
vector/buckets/observability/ingress/dns/registry/controllerDb deploys and their reconcile workers;
env/secret/config re-wires (`configsMgr`, `secretsMgr`, `ai.attach`, blueprint `mergeServiceEnv`)
that redeploy the live image unchanged; `region-reconcile` replicas; `deploy-canary` worker rollback
to the stable image.

**Tests:** `packages/trpc/src/services/service.service.test.ts` — `:latest` into a production stack
under safety mode and under the individually-armed block rule is refused with nothing dispatched and
a `guardrails.deploy.blocked` row; member override of a block is FORBIDDEN, admin override deploys
with `service.deploy.override` + `service.deploy` rows; a compliant deploy writes `service.deploy`;
`updateService` refuses `:latest` on a prod service and preserves `swarmy.env`.

**Follow-ups (not done here):**
- `/services/new` UI has no override affordance — a refused deploy now shows the policy error; an
  admin override needs a toggle like `rollback-confirm.tsx` (UI owned by another agent).
- REST `POST /services` can now return 412 but the OpenAPI route doesn't declare it, and neither REST
  `POST /stacks` nor `POST /services` exposes `override` (contract change → `openapi.json`/SDK regen).
- `autodeployBuilt` dispatches a bare `{name,image,replicas}` spec — it strips labels, env, ports,
  networks, secrets from the live service (incl. `swarmy.env`), and audits `cicd.autodeploy` even when
  the dispatch fails (`.catch(() => undefined)`). Separate cicd bug.
- `startCanary` refuses only on `block` and has no override path — deliberate divergence left as is.

