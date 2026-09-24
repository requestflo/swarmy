import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  confirmAppActions,
  detectDrift,
  getPlan,
  listApps,
  listPlans,
  purgeAppData,
  replan,
  setEnforceDrift,
  setRequireApproval,
  type AppPlanView,
  type AppView,
  type PlanCommitResult,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAction, requireAdmin, requireScope } from '../middleware';
import { ProblemDto, listEnvelope } from '../dto';
import { run } from '../respond';

/**
 * GitOps apps (`/v1/apps/*`) — the REST twin of the `apps` tRPC router over
 * the SAME `apps.service` functions: the apps a linked repo's swarmy.yaml
 * describes, their plans per environment, confirming held (destructive) steps,
 * the per-app require-approval toggle, "deploy the branch head now", and a
 * read-only drift check.
 *
 * Confirming is authorized PER STEP inside the service by what the step
 * destroys (`data.destroy` / `service.remove` / `stack.deploy`); a denied step
 * is a `403` problem. The public plan shape is deliberately flat (id, kind,
 * gate, reason, outcome) — the internal per-kind action payload is not part of
 * the contract.
 */

const Gate = z.enum(['auto', 'confirm', 'blocked']).openapi('AppPlanGate', {
  description: '`auto` runs on its own, `confirm` waits for POST /apps/plans/{planId}/confirm, `blocked` cannot run.',
});

const AppPlanActionDto = z
  .object({
    id: z.string().openapi({ example: 'resource.delete:files', description: 'Stable id — confirm by this.' }),
    kind: z.string().openapi({ example: 'service.deploy', description: 'Open set (resource.create, build, service.deploy, route.add, …).' }),
    phase: z.number().int(),
    gate: Gate,
    reason: z.string(),
    outcome: z.string().nullable().openapi({ description: '`done`, `held`, `failed`, `skipped`, or null (not run).' }),
    outcome_message: z.string().nullable(),
  })
  .openapi('AppPlanAction');

const AppConfigIssueDto = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z.string(),
    message: z.string(),
    path: z.string().openapi({ example: 'services.web.env.DATABASE_URL' }),
    line: z.number().int().nullable(),
    col: z.number().int().nullable(),
  })
  .openapi('AppConfigIssue');

const AppPlanCountsDto = z
  .object({ auto: z.number().int(), confirm: z.number().int(), blocked: z.number().int() })
  .openapi('AppPlanCounts');

const AppPlanDto = z
  .object({
    id: z.string(),
    repo_id: z.string(),
    environment: z.string(),
    stack: z.string(),
    sha: z.string(),
    trigger: z.string().openapi({ description: 'push, pr, manual, poll, drift, confirm (open set).' }),
    pr_number: z.number().int().nullable(),
    status: z.string().openapi({
      description: 'Plan row status, e.g. planned, needs-confirmation, applying, applied, failed, superseded (open set).',
    }),
    plan_status: z.string().nullable().openapi({ description: 'noop, ready, needs-confirmation, blocked — null when the config did not parse.' }),
    counts: AppPlanCountsDto,
    actions: z.array(AppPlanActionDto),
    issues: z.array(AppConfigIssueDto),
    error: z.string().nullable(),
    confirmed_ids: z.array(z.string()),
    markdown: z.string().openapi({ description: 'The plan as the PR comment renders it.' }),
    created_at: z.string(),
    applied_at: z.string().nullable(),
  })
  .openapi('AppPlan');

const AppEnvironmentDto = z
  .object({
    environment: z.string().openapi({ example: 'production' }),
    branch: z.string(),
    stack: z.string(),
    latest_plan_id: z.string().nullable(),
    latest_plan_status: z.string().nullable(),
    latest_sha: z.string().nullable(),
    latest_created_at: z.string().nullable(),
  })
  .openapi('AppEnvironment');

const AppPreviewDto = z
  .object({
    pr: z.number().int(),
    stack: z.string(),
    sha: z.string(),
    status: z.string(),
    url: z.string().nullable(),
    updated_at: z.string(),
    plan_id: z.string(),
  })
  .openapi('AppPreview');

const AppDriftDto = z
  .object({ environment: z.string(), stack: z.string(), changes: z.number().int() })
  .openapi('AppDrift');

// Inline (not a named component) so `nullable` survives; SDKs name it AppDriftCheck.
const AppDriftCheckDto = z.object({ checked_at: z.string(), environments: z.array(AppDriftDto) });

const AppDto = z
  .object({
    repo_id: z.string(),
    url: z.string(),
    full_name: z.string().nullable(),
    branch: z.string(),
    config_path: z.string(),
    app_name: z.string().nullable(),
    require_approval: z.boolean(),
    enforce_drift: z.boolean(),
    environments: z.array(AppEnvironmentDto),
    previews: z.array(AppPreviewDto).openapi({ description: 'Live PR previews (latest plan per PR).' }),
    drift: AppDriftCheckDto.nullable().openapi({
      description: 'The last drift check (refreshed by the controller every ~10 min); null = not checked yet.',
    }),
  })
  .openapi('App');

const ConfirmBody = z
  .object({ action_ids: z.array(z.string().min(1).max(300)).min(1).max(50) })
  .openapi('ConfirmAppActionsBody');
const ConfirmResultDto = z
  .object({ status: z.string(), confirmed: z.array(z.string()) })
  .openapi('ConfirmAppActionsResult');

const RequireApprovalBody = z.object({ require_approval: z.boolean() }).openapi('SetRequireApprovalBody');
const RequireApprovalDto = z
  .object({ repo_id: z.string(), require_approval: z.boolean() })
  .openapi('AppRequireApproval');

const DeployBody = z
  .object({
    branch: z.string().min(1).max(200).optional().openapi({ description: 'Branch head to plan + apply (default: the production branch).' }),
  })
  .openapi('DeployAppBody');
const PlanCommitResultDto = z
  .object({
    plan_id: z.string().nullable(),
    status: z.string(),
    environment: z.string().nullable(),
    stack: z.string().nullable(),
    reason: z.string().nullable(),
    plan: AppPlanDto.nullable().openapi({ description: 'The plan the deploy recorded (null when nothing was planned).' }),
  })
  .openapi('AppDeployResult');

const EnforceDriftBody = z.object({ enforce_drift: z.boolean() }).openapi('SetEnforceDriftBody');
const EnforceDriftDto = z.object({ repo_id: z.string(), enforce_drift: z.boolean() }).openapi('AppEnforceDrift');

const PurgeBody = z
  .object({
    resource: z.string().min(1).max(40).openapi({ example: 'db' }),
    confirm: z.string().min(1).max(200).openapi({
      example: 'shop/db',
      description: 'Must be exactly `<stack>/<resource>` — the typed confirmation.',
    }),
  })
  .openapi('PurgeAppDataBody');
const PurgeResultDto = z
  .object({
    stack: z.string(),
    resource: z.string(),
    volumes: z.array(z.string()),
    nodes: z.number().int().openapi({ description: 'Online nodes the volumes were removed from.' }),
  })
  .openapi('PurgeAppDataResult');

const AppList = listEnvelope(AppDto, 'AppList');
const AppPlanList = listEnvelope(AppPlanDto, 'AppPlanList');
const AppDriftList = listEnvelope(AppDriftDto, 'AppDriftList');

const repoParam = z.object({ repoId: z.string().min(1).max(100).openapi({ param: { name: 'repoId', in: 'path' } }) });
const planParam = z.object({ planId: z.string().min(1).max(100).openapi({ param: { name: 'planId', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({ content: { 'application/json': { schema } } });
const TAG = 'Apps';

// ── mappers ──────────────────────────────────────────────────────────────────

export function appPlanToDto(v: AppPlanView): z.infer<typeof AppPlanDto> {
  return {
    id: v.id,
    repo_id: v.repoId,
    environment: v.environment,
    stack: v.stack,
    sha: v.sha,
    trigger: v.trigger,
    pr_number: v.prNumber,
    status: v.status,
    plan_status: v.plan?.status ?? null,
    counts: {
      auto: v.plan?.counts.auto ?? 0,
      confirm: v.plan?.counts.confirm ?? 0,
      blocked: v.plan?.counts.blocked ?? 0,
    },
    actions: (v.plan?.actions ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
      phase: a.phase,
      gate: a.gate,
      reason: a.reason,
      outcome: v.outcomes[a.id]?.status ?? null,
      outcome_message: v.outcomes[a.id]?.message ?? null,
    })),
    issues: v.issues.map((i) => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      path: i.path.join('.'),
      line: i.line ?? null,
      col: i.col ?? null,
    })),
    error: v.error,
    confirmed_ids: v.confirmedIds,
    markdown: v.markdown,
    created_at: v.createdAt,
    applied_at: v.appliedAt,
  };
}

export function appToDto(v: AppView): z.infer<typeof AppDto> {
  return {
    repo_id: v.repoId,
    url: v.url,
    full_name: v.fullName,
    branch: v.branch,
    config_path: v.configPath,
    app_name: v.appName,
    require_approval: v.requireApproval,
    enforce_drift: v.enforceDrift,
    previews: v.previews.map((p) => ({
      pr: p.pr,
      stack: p.stack,
      sha: p.sha,
      status: p.status,
      url: p.url,
      updated_at: p.updatedAt,
      plan_id: p.planId,
    })),
    drift: v.drift ? { checked_at: v.drift.checkedAt, environments: v.drift.environments } : null,
    environments: v.environments.map((e) => ({
      environment: e.environment,
      branch: e.branch,
      stack: e.stack,
      latest_plan_id: e.latest?.id ?? null,
      latest_plan_status: e.latest?.status ?? null,
      latest_sha: e.latest?.sha ?? null,
      latest_created_at: e.latest?.createdAt ?? null,
    })),
  };
}

export function planCommitResultToDto(
  r: PlanCommitResult & { plan?: AppPlanView | null },
): z.infer<typeof PlanCommitResultDto> {
  return {
    plan_id: r.planId,
    status: r.status,
    environment: r.environment,
    stack: r.stack,
    reason: r.reason ?? null,
    plan: r.plan ? appPlanToDto(r.plan) : null,
  };
}

export function registerAppRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/apps',
      tags: [TAG],
      summary: 'List GitOps apps (linked repos) with each environment’s latest plan',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: AppList } }, description: 'Apps' },
        401: problemRes,
      },
    }),
    (c) => run(c, async () => ({ data: (await listApps(c.get('orgCtx'))).map(appToDto), next_cursor: null })),
  );

  // Registered before /apps/{repoId}/… so `/apps/plans/{id}` never reads as a repo id.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/apps/plans/{planId}',
      tags: [TAG],
      summary: 'Get a plan',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: planParam },
      responses: {
        200: { content: { 'application/json': { schema: AppPlanDto } }, description: 'Plan' },
        404: problemRes,
      },
    }),
    (c) => run(c, async () => appPlanToDto(await getPlan(c.get('orgCtx'), c.req.param('planId')))),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/apps/plans/{planId}/confirm',
      tags: [TAG],
      summary: 'Confirm held steps of a plan, then apply them',
      description:
        'Each step is authorized by what it destroys (data.destroy / service.remove / stack.deploy); a step the key’s principal may not confirm fails the whole call with `403`. Ids that are not held (or no longer planned) are ignored.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: planParam, body: jsonBody(ConfirmBody) },
      responses: {
        200: { content: { 'application/json': { schema: ConfirmResultDto } }, description: 'Confirmed' },
        400: problemRes,
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, () =>
        confirmAppActions(c.get('orgCtx'), {
          planId: c.req.param('planId'),
          actionIds: c.req.valid('json').action_ids,
        }),
      ),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/apps/{repoId}/plans',
      tags: [TAG],
      summary: 'List an app’s plans (newest first)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: {
        params: repoParam,
        query: z.object({
          environment: z.string().min(1).max(40).optional().openapi({ param: { name: 'environment', in: 'query' } }),
          limit: z.coerce.number().int().min(1).max(100).optional().openapi({ param: { name: 'limit', in: 'query' } }),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: AppPlanList } }, description: 'Plans' },
        400: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const q = c.req.valid('query');
        return {
          data: (
            await listPlans(c.get('orgCtx'), {
              repoId: c.req.param('repoId'),
              ...(q.environment ? { environment: q.environment } : {}),
              ...(q.limit ? { limit: q.limit } : {}),
            })
          ).map(appPlanToDto),
          next_cursor: null,
        };
      }),
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/apps/{repoId}/require-approval',
      tags: [TAG],
      summary: 'Set the app’s require-approval toggle (every step waits for confirmation)',
      description: 'Admin/owner only.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { params: repoParam, body: jsonBody(RequireApprovalBody) },
      responses: {
        200: { content: { 'application/json': { schema: RequireApprovalDto } }, description: 'Set' },
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const r = await setRequireApproval(c.get('orgCtx'), {
          repoId: c.req.param('repoId'),
          requireApproval: c.req.valid('json').require_approval,
        });
        return { repo_id: r.repoId, require_approval: r.requireApproval };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/apps/{repoId}/deploy',
      tags: [TAG],
      summary: 'Plan and apply the head of a branch now',
      description:
        'Runs the same plan → apply as a push (destructive steps still wait for confirmation). Returns when the plan is recorded and its runnable part applied. Admin/owner only.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { params: repoParam, body: jsonBody(DeployBody) },
      responses: {
        200: { content: { 'application/json': { schema: PlanCommitResultDto } }, description: 'Planned' },
        403: problemRes,
        404: problemRes,
        412: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const b = c.req.valid('json');
        return planCommitResultToDto(
          await replan(c.get('orgCtx'), { repoId: c.req.param('repoId'), ...(b.branch ? { branch: b.branch } : {}) }),
        );
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/apps/{repoId}/drift',
      tags: [TAG],
      summary: 'Compare each environment’s last applied commit with live state (changes nothing)',
      description: 'An empty list means no drift.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: repoParam },
      responses: {
        200: { content: { 'application/json': { schema: AppDriftList } }, description: 'Drift per environment' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => ({
        data: await detectDrift(c.get('orgCtx'), c.req.param('repoId'), { notify: false }),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/apps/{repoId}/enforce-drift',
      tags: [TAG],
      summary: 'Opt in (or out) of re-applying drift on git-owned fields',
      description:
        'Default is report-only. When on, drift is re-applied as a `drift`-triggered plan; destructive steps still wait for confirmation. Admin/owner only.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { params: repoParam, body: jsonBody(EnforceDriftBody) },
      responses: {
        200: { content: { 'application/json': { schema: EnforceDriftDto } }, description: 'Set' },
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const r = await setEnforceDrift(c.get('orgCtx'), {
          repoId: c.req.param('repoId'),
          enforceDrift: c.req.valid('json').enforce_drift,
        });
        return { repo_id: r.repoId, enforce_drift: r.enforceDrift };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/apps/{repoId}/environments/{environment}/purge',
      tags: [TAG],
      summary: 'Delete a REMOVED managed Postgres’s data permanently (its volumes on every node)',
      description:
        'Irreversible. Requires `data.destroy` (checked at the route AND per resource in the service) and the typed confirmation `confirm: "<stack>/<resource>"`. Refused (400) while swarmy.yaml still declares the resource, its removal is not yet confirmed, or it is still running.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('data.destroy')] as const,
      request: {
        params: repoParam.extend({
          environment: z.string().min(1).max(40).openapi({ param: { name: 'environment', in: 'path' } }),
        }),
        body: jsonBody(PurgeBody),
      },
      responses: {
        200: { content: { 'application/json': { schema: PurgeResultDto } }, description: 'Deleted' },
        400: problemRes,
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, () => {
        const b = c.req.valid('json');
        return purgeAppData(c.get('orgCtx'), {
          repoId: c.req.param('repoId'),
          environment: c.req.param('environment'),
          resource: b.resource,
          confirm: b.confirm,
        });
      }),
  );
}
