import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { resolveService } from '@swarmy/trpc';
import {
  collectServiceLogs,
  createAppPreview,
  enableForStack,
  errorsStackStatus,
  getDeployStatus,
  rotateErrorsKey,
  patchServiceEnv,
  readServiceEnv,
  serviceLogLines,
  stackTelemetryEnabled,
  type ErrorProjectView,
  type ServiceEnvView,
} from '@swarmy/trpc/devx';
import type { RestEnv } from '../middleware';
import { requireAction, requireAdmin, requireScope } from '../middleware';
import { ProblemDto, listEnvelope } from '../dto';
import { PROBLEM_CONTENT_TYPE, trpcErrorToProblem } from '../problem';
import { run } from '../respond';

/**
 * The developer-loop endpoints behind the `swarmy` CLI and MCP server — each
 * a thin adapter over an existing service (`devx.service`, deployments,
 * previews, observability):
 *
 *   GET   /me                          who this credential acts as + its scopes
 *   GET   /services/{id}/env           env as a flat list; secrets withheld
 *   PATCH /services/{id}/env           merge-patch env (plain + secret vars) → rollout
 *   GET   /services/{id}/logs          the last N lines (bounded)
 *   GET   /services/{id}/logs/stream   follow, as Server-Sent Events
 *   GET   /deployments/{id}            a deploy's convergence
 *   POST  /apps/{repoId}/previews      preview a branch (trial deploy)
 *   GET   /stacks/{id}/telemetry       OpenTelemetry opt-in state
 *   PUT   /stacks/{id}/telemetry       flip it (admin)
 *   GET   /stacks/{id}/errors          error tracking: opt-in state + the DSN
 *   POST  /stacks/{id}/errors/rotate-key   new DSN key; the old one stops at once (admin)
 *
 * Secret values are write-only by default: `reveal_secrets=true` is honoured
 * only for a key holding the `secrets.read` scope AND an ABAC `secrets.read`
 * permit on the service (owners/admins by default); every reveal is audited.
 */

const TAG = 'Developer';

const PrincipalDto = z
  .object({
    org_id: z.string(),
    user: z.object({ id: z.string(), email: z.string().nullable(), name: z.string().nullable() }),
    role: z.enum(['owner', 'admin', 'member']),
    credential: z.object({
      kind: z.enum(['api_key', 'oauth']),
      id: z.string().openapi({ description: 'API key id, or `oauth:<client_id>` for an OAuth token.' }),
      scopes: z.array(z.string()).openapi({ description: '`read`, `write`, `secrets.read` (open set).' }),
    }),
  })
  .openapi('Principal');

const EnvVarDto = z
  .object({
    key: z.string(),
    value: z.string().nullable().openapi({ description: 'null = withheld (a secret this call may not read).' }),
    secret: z.boolean().openapi({ description: 'A secret variable (Docker secret), or a plain value that looks secret.' }),
    delivery: z.enum(['env', 'file']).nullable().openapi({ description: 'How a secret variable reaches the process; null for plain.' }),
    withheld: z.boolean(),
    error: z.string().nullable().openapi({ description: 'Why a requested reveal failed (e.g. no running task).' }),
  })
  .openapi('ServiceEnvVar');

const ServiceEnvDto = z
  .object({
    service_id: z.string(),
    service: z.string(),
    vars: z.array(EnvVarDto),
    secrets_readable: z.boolean().openapi({ description: 'Whether the principal holds ABAC `secrets.read` on this service.' }),
  })
  .openapi('ServiceEnv');

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const PatchEnvBody = z
  .object({
    set: z.record(EnvName, z.string().max(32_768)).optional().openapi({ description: 'Plain variables to add or change.' }),
    secrets: z
      .record(EnvName, z.string().min(1).max(500_000))
      .optional()
      .openapi({ description: 'Secret variables to create or rotate. Stored as Docker secrets; never readable back without `secrets.read`.' }),
    unset: z.array(EnvName).max(500).optional().openapi({ description: 'Keys to remove (plain or secret).' }),
  })
  .openapi('PatchServiceEnvBody');

const PatchEnvResultDto = z
  .object({ id: z.string(), deployment_id: z.string(), changed: z.array(z.string()) })
  .openapi('PatchServiceEnvResult');

const LogLineDto = z
  .object({
    seq: z.number().int(),
    stream: z.enum(['stdout', 'stderr']),
    ts: z.number().nullable().openapi({ description: 'Unix ms, when Docker stamped the line.' }),
    message: z.string(),
  })
  .openapi('LogLine');
const LogLineList = listEnvelope(LogLineDto, 'LogLineList');

const DeploymentStatusDto = z
  .object({
    deployment_id: z.string(),
    service_id: z.string().nullable(),
    kind: z.string(),
    phase: z.string().openapi({ description: 'converging, complete, failed, rolledback, canceled (open set).' }),
    desired: z.number().int().nullable(),
    ready: z.number().int().nullable(),
    message: z.string().nullable(),
    started_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .openapi('DeploymentStatus');

const PreviewBody = z
  .object({ branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/) })
  .openapi('CreatePreviewBody');
const PreviewResultDto = z
  .object({
    action: z.string().openapi({ description: 'deployed, skipped or failed (open set).' }),
    stack: z.string().nullable(),
    url: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .openapi('PreviewResult');

const TelemetryDto = z.object({ stack: z.string(), enabled: z.boolean() }).openapi('StackTelemetry');
const TelemetryBody = z.object({ enabled: z.boolean() }).openapi('SetStackTelemetryBody');

const ErrorProjectDto = z
  .object({
    stack: z.string(),
    project_id: z.number().int(),
    dsn: z.string().openapi({ description: 'The Sentry-compatible DSN apps send to.' }),
    rate_limit_per_minute: z.number().int(),
    created_at: z.string(),
    rotated_at: z.string().nullable(),
  })
  .openapi('ErrorProject');
const ErrorsStatusDto = z
  .object({
    stack: z.string(),
    enabled: z.boolean(),
    store_enabled: z.boolean().openapi({ description: 'Whether the observability store (ClickHouse) is on.' }),
    project: ErrorProjectDto.nullable(),
    pending_redeploy: z.array(z.string()).openapi({ description: 'Opted-in services that need a redeploy to receive SENTRY_DSN.' }),
  })
  .openapi('StackErrorsStatus');

export function errorProjectToDto(p: ErrorProjectView): z.infer<typeof ErrorProjectDto> {
  return {
    stack: p.stack,
    project_id: p.projectId,
    dsn: p.dsn,
    rate_limit_per_minute: p.rateLimitPerMinute,
    created_at: p.createdAt,
    rotated_at: p.rotatedAt,
  };
}

const idParam = z.object({ id: z.string().min(1).max(200).openapi({ param: { name: 'id', in: 'path' } }) });
const repoParam = z.object({ repoId: z.string().min(1).max(100).openapi({ param: { name: 'repoId', in: 'path' } }) });
const problemRes = { content: { 'application/problem+json': { schema: ProblemDto } }, description: 'Problem' };
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({ content: { 'application/json': { schema } } });

// ── mappers ──────────────────────────────────────────────────────────────────

export function serviceEnvToDto(v: ServiceEnvView): z.infer<typeof ServiceEnvDto> {
  return {
    service_id: v.serviceId,
    service: v.service,
    secrets_readable: v.secretsReadable,
    vars: v.vars.map((x) => ({
      key: x.key,
      value: x.value,
      secret: x.secret,
      delivery: x.delivery,
      withheld: x.withheld,
      error: x.error ?? null,
    })),
  };
}

export function registerDevxRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags: [TAG],
      summary: 'Who this credential acts as, and what it may do',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: PrincipalDto } }, description: 'Principal' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const ctx = c.get('orgCtx');
        const key = c.get('apiKey');
        return {
          org_id: ctx.activeOrgId,
          user: { id: ctx.user.id, email: ctx.user.email ?? null, name: ctx.user.name ?? null },
          role: ctx.membership.role,
          credential: { kind: key.kind ?? 'api_key', id: key.id, scopes: key.scopes },
        };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/services/{id}/env',
      tags: [TAG],
      summary: "A service's environment, secrets withheld",
      description:
        'Plain variables with their values; secret variables (and plain values that look secret) with `value: null` unless `reveal_secrets=true` AND the key holds the `secrets.read` scope AND policy permits `secrets.read` on the service. Every reveal is audited.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: {
        params: idParam,
        query: z.object({
          reveal_secrets: z
            .enum(['true', 'false'])
            .optional()
            .openapi({ param: { name: 'reveal_secrets', in: 'query' } }),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: ServiceEnvDto } }, description: 'Environment' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const wantsReveal = c.req.valid('query').reveal_secrets === 'true';
        const mayReveal = c.get('apiKey').scopes.includes('secrets.read');
        return serviceEnvToDto(
          await readServiceEnv(c.get('orgCtx'), { id: c.req.param('id'), revealSecrets: wantsReveal && mayReveal }),
        );
      }),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/services/{id}/env',
      tags: [TAG],
      summary: "Merge-patch a service's environment (async rollout)",
      description:
        'Keys not named are kept exactly (secret variables included). `secrets` become Docker secrets (new versions, rolling update). Policy: `service.configure` on the service.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('deploy'), requireAction('service.configure', resolveService)] as const,
      request: { params: idParam, body: jsonBody(PatchEnvBody) },
      responses: {
        202: { content: { 'application/json': { schema: PatchEnvResultDto } }, description: 'Rolling out' },
        400: problemRes,
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const body = c.req.valid('json');
          const r = await patchServiceEnv(c.get('orgCtx'), {
            id: c.req.param('id'),
            ...(body.set ? { set: body.set } : {}),
            ...(body.secrets ? { secrets: body.secrets } : {}),
            ...(body.unset ? { unset: body.unset } : {}),
          });
          return { id: r.id, deployment_id: r.deploymentId, changed: r.changed };
        },
        202,
      ),
  );

  const logsQuery = z.object({
    tail: z.coerce.number().int().min(0).max(5000).optional().openapi({ param: { name: 'tail', in: 'query' } }),
    since: z.coerce.number().int().min(0).optional().openapi({
      param: { name: 'since', in: 'query' },
      description: 'Unix seconds; only lines after this time.',
    }),
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/services/{id}/logs',
      tags: [TAG],
      summary: 'The last lines of a service’s logs (all tasks)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam, query: logsQuery },
      responses: {
        200: { content: { 'application/json': { schema: LogLineList } }, description: 'Log lines, oldest first' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const q = c.req.valid('query');
        const lines = await collectServiceLogs(c.get('orgCtx'), {
          id: c.req.param('id'),
          tail: q.tail ?? 200,
          ...(q.since !== undefined ? { since: q.since } : {}),
        });
        return { data: lines, next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/services/{id}/logs/stream',
      tags: [TAG],
      summary: 'Follow a service’s logs (Server-Sent Events)',
      description: 'Each `data:` event is one LogLine as JSON. The stream stays open until the client disconnects.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam, query: logsQuery },
      responses: {
        200: { content: { 'text/event-stream': { schema: z.string() } }, description: 'SSE stream of LogLine events' },
        404: problemRes,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      const q = c.req.valid('query') as { tail?: number; since?: number };
      const ac = new AbortController();
      let lines: AsyncIterable<unknown>;
      try {
        lines = await serviceLogLines(
          c.get('orgCtx'),
          { id: c.req.param('id'), tail: q.tail ?? 100, follow: true, ...(q.since !== undefined ? { since: q.since } : {}) },
          ac.signal,
        );
      } catch (e) {
        const p = trpcErrorToProblem(e, c.req.path);
        return c.json(p, p.status, { 'content-type': PROBLEM_CONTENT_TYPE });
      }
      return streamSSE(c, async (stream) => {
        stream.onAbort(() => ac.abort());
        try {
          for await (const l of lines) await stream.writeSSE({ data: JSON.stringify(l) });
        } finally {
          ac.abort();
        }
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/deployments/{id}',
      tags: [TAG],
      summary: 'A deployment’s convergence (poll until a terminal phase)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: DeploymentStatusDto } }, description: 'Status' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const s = getDeployStatus(c.get('orgCtx'), c.req.param('id'));
        return {
          deployment_id: s.deploymentId,
          service_id: s.serviceId,
          kind: s.kind,
          phase: s.phase,
          desired: s.desired,
          ready: s.ready,
          message: s.message,
          started_at: s.startedAt,
          finished_at: s.finishedAt,
        };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/apps/{repoId}/previews',
      tags: [TAG],
      summary: 'Preview a branch (trial deploy)',
      description:
        'Plans the branch’s swarmy.yaml and deploys it as a preview environment with its own stack and URL, the same machinery as a branch or pull-request preview. Torn down by `previews.ttl` or when the branch is deleted.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('deploy')] as const,
      request: { params: repoParam, body: jsonBody(PreviewBody) },
      responses: {
        202: { content: { 'application/json': { schema: PreviewResultDto } }, description: 'Preview result' },
        400: problemRes,
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const r = await createAppPreview(c.get('orgCtx'), {
            repoId: c.req.param('repoId'),
            branch: c.req.valid('json').branch,
          });
          return { action: r.action, stack: r.stack ?? null, url: r.url ?? null, reason: r.reason ?? null };
        },
        202,
      ),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/stacks/{id}/telemetry',
      tags: [TAG],
      summary: 'Whether OpenTelemetry is on for a stack',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: { 200: { content: { 'application/json': { schema: TelemetryDto } }, description: 'State' } },
    }),
    (c) =>
      run(c, async () => ({
        stack: c.req.param('id'),
        enabled: stackTelemetryEnabled(c.get('orgCtx'), c.req.param('id')),
      })),
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/stacks/{id}/telemetry',
      tags: [TAG],
      summary: 'Turn OpenTelemetry on or off for a stack',
      description: 'Stamps/clears the stack’s telemetry label; the next deploy (un)injects OTEL_* env. Admin/owner only.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { params: idParam, body: jsonBody(TelemetryBody) },
      responses: {
        200: { content: { 'application/json': { schema: TelemetryDto } }, description: 'Set' },
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const r = await enableForStack(c.get('orgCtx'), { stackId: c.req.param('id'), enabled: c.req.valid('json').enabled });
        return { stack: r.id, enabled: r.enabled };
      }),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/stacks/{id}/errors',
      tags: [TAG],
      summary: 'Error tracking for a stack: opt-in state and the DSN',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: { 200: { content: { 'application/json': { schema: ErrorsStatusDto } }, description: 'Status' } },
    }),
    (c) =>
      run(c, async () => {
        const s = await errorsStackStatus(c.get('orgCtx'), c.req.param('id'));
        return {
          stack: c.req.param('id'),
          enabled: s.enabled,
          store_enabled: s.storeEnabled,
          project: s.project ? errorProjectToDto(s.project) : null,
          pending_redeploy: s.pendingRedeploy,
        };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/stacks/{id}/errors/rotate-key',
      tags: [TAG],
      summary: 'Rotate the stack’s DSN key (the old key stops working at once)',
      description: 'Apps pick up the new DSN on their next deploy. Admin/owner only.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: ErrorProjectDto } }, description: 'Rotated' },
        403: problemRes,
      },
    }),
    (c) => run(c, async () => errorProjectToDto(await rotateErrorsKey(c.get('orgCtx'), c.req.param('id')))),
  );
}
