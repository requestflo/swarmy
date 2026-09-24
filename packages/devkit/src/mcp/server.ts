/**
 * The swarmy MCP server: one tool set, two transports.
 *
 *   - stdio — `swarmy mcp`, run by the MCP host on the developer's machine
 *     with the CLI's stored credential. `check_repo` reads the local disk.
 *   - HTTP  — `<controller>/mcp`, authed per request (API key or an OAuth
 *     token from swarmy's OIDC provider). `check_repo` takes file contents.
 *
 * Every tool goes through the public REST API via the TypeScript SDK, so the
 * server can do exactly what the credential may do and nothing more: API-key
 * scope first, then the org's ABAC policy on the controller. Read-only by
 * default — the mutating tools are registered only when the credential
 * carries the `write` scope and the host did not ask for read-only.
 */
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { checkRepo, formatCheckReport, memoryRepoFs, nodeRepoFs, type CheckReport } from '../check';
import { explainError, formatExplanations } from '../explain';
import { NotFoundError, appStack, resolveApp, resolveService, stackServices } from '../resolve';
import { SwarmyApiError, type SwarmyClient } from '../sdk';
import path from 'node:path';

export const MCP_SERVER_NAME = 'swarmy';

export interface SwarmyMcpOptions {
  client: SwarmyClient;
  /** The credential's scopes (from GET /me). */
  scopes: readonly string[];
  /** Where the server runs: stdio may read the local disk, HTTP may not. */
  transport: 'stdio' | 'http';
  /** Force read-only even for a write-scoped credential. */
  readOnly?: boolean;
  /** Base for relative `check_repo` paths (stdio). */
  cwd?: string;
  version?: string;
  /** Controller URL, for dashboard links in answers. */
  controllerUrl?: string;
}

/** Names of the tools that change something (registered only with write scope). */
export const MUTATING_TOOLS = ['deploy', 'trial_deploy', 'env_set', 'telemetry_toggle'] as const;
export const READ_TOOLS = ['check_repo', 'list_apps', 'app_status', 'logs', 'env', 'explain_error'] as const;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, data?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(data !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)
      ? { structuredContent: data as Record<string, unknown> }
      : {}),
  };
}

function fail(e: unknown): ToolResult {
  let text: string;
  if (e instanceof SwarmyApiError) {
    const p = e.problem;
    text = `swarmy API error ${e.status}${p.swarmy_code ? ` (${p.swarmy_code})` : ''}: ${p.detail ?? p.title}`;
    if (e.status === 403) text += '\nThe credential is not allowed to do this (key scope, role, or an org policy).';
  } else if (e instanceof NotFoundError) {
    text = e.message;
  } else {
    text = e instanceof Error ? e.message : String(e);
  }
  return { content: [{ type: 'text', text }], isError: true };
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Build the server. Call once per connection (stdio) or per request (HTTP). */
export function createSwarmyMcpServer(opts: SwarmyMcpOptions): McpServer {
  const { client } = opts;
  const canWrite = !opts.readOnly && opts.scopes.includes('write');
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: opts.version ?? '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        'swarmy deploys apps onto a self-hosted Docker Swarm. Apps are git repos with a swarmy.yaml;',
        'each environment (production, staging, previews) is its own stack of services.',
        'Start with list_apps or app_status. Use check_repo before a first deploy.',
        canWrite
          ? 'This credential may deploy and change settings; confirm with the user before deploy, env_set or telemetry_toggle.'
          : 'This connection is READ-ONLY: it can inspect, check and explain, but not deploy or change anything.',
      ].join(' '),
    },
  );

  // ── read tools ─────────────────────────────────────────────────────────────

  server.registerTool(
    'check_repo',
    {
      title: 'Will this repo work on swarmy?',
      description:
        'Checks a repository locally and reports how swarmy would deploy it: finds swarmy.yaml (validating it with the exact parser the controller uses, with line numbers), or a compose file, a Dockerfile, or a stack Railpack can build (Node, Python, Go, …); lists the services, databases, domains and jobs a deploy would create; and every problem that would stop it. Deploys nothing and calls no server. ' +
        (opts.transport === 'stdio'
          ? 'Pass `path` (a local directory, default the current one).'
          : 'Pass `files`: the contents of swarmy.yaml plus the manifests that matter (package.json, Dockerfile, lockfiles, pyproject.toml, go.mod, …) keyed by repo-relative path.'),
      inputSchema: z.object({
        path: z.string().optional().describe('Local directory to check (stdio only). Default: the current directory.'),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe('Repo-relative path → file contents, when the repo is not on this machine.'),
        config_path: z.string().optional().describe('Path of swarmy.yaml if not at the repo root.'),
      }),
      annotations: READ,
    },
    async ({ path: dir, files, config_path }) =>
      guard(async () => {
        let report: CheckReport;
        if (files && Object.keys(files).length) {
          report = await checkRepo(memoryRepoFs(files), config_path ? { configPath: config_path } : {});
        } else if (opts.transport === 'stdio') {
          const root = path.resolve(opts.cwd ?? process.cwd(), dir ?? '.');
          report = await checkRepo(nodeRepoFs(root), {
            name: path.basename(root),
            ...(config_path ? { configPath: config_path } : {}),
          });
        } else {
          throw new Error('this server runs on the controller and cannot read your disk — pass `files` (swarmy.yaml, package.json, Dockerfile, …)');
        }
        return ok(formatCheckReport(report), report);
      }),
  );

  server.registerTool(
    'list_apps',
    {
      title: 'List apps',
      description:
        'Lists the apps (git repos with a swarmy.yaml) in this swarmy org: each app’s environments with the stack they deploy to, the latest plan status and commit, live pull-request previews, and whether live state has drifted from git.',
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () =>
      guard(async () => {
        const { data } = await client.apps.list();
        const apps = data.map((a) => ({
          app: a.app_name ?? a.full_name ?? a.repo_id,
          repo_id: a.repo_id,
          repo: a.full_name ?? a.url,
          branch: a.branch,
          environments: a.environments.map((e) => ({
            environment: e.environment,
            stack: e.stack,
            branch: e.branch,
            status: e.latest_plan_status,
            sha: e.latest_sha?.slice(0, 7) ?? null,
            at: e.latest_created_at,
          })),
          previews: a.previews.map((p) => ({ pr: p.pr, url: p.url, status: p.status })),
          drift: a.drift?.environments.filter((d) => d.changes > 0) ?? [],
        }));
        return ok(apps.length ? json(apps) : 'No apps yet. Link a repo with a swarmy.yaml in the dashboard (CI → Apps), or swarmy link.', { apps });
      }),
  );

  server.registerTool(
    'app_status',
    {
      title: 'App status',
      description:
        'Everything about one app’s health: for an environment (default production), each service’s running/desired replicas, status and the last error Swarm reported, the latest deploy plan (what it did, what is held for confirmation, config problems), drift from git, and previews. Use this first when someone asks "is it up?" or "why is it broken?".',
      inputSchema: z.object({
        app: z.string().describe('App name, repo id, or repo full name (org/repo).'),
        environment: z.string().optional().describe('Environment name. Default: production.'),
      }),
      annotations: READ,
    },
    async ({ app: ref, environment }) =>
      guard(async () => {
        const app = await resolveApp(client, ref);
        const envName = environment ?? 'production';
        const stack = appStack(app, envName);
        const env = app.environments.find((e) => e.environment === envName)!;
        const services = await stackServices(client, stack);
        const detailed = await Promise.all(services.map((s) => client.services.get(s.id).catch(() => s)));
        const plan = env.latest_plan_id ? await client.apps.plan(env.latest_plan_id).catch(() => null) : null;
        const status = {
          app: app.app_name ?? app.full_name,
          environment: envName,
          stack,
          services: detailed.map((s) => ({
            name: s.name,
            id: s.id,
            status: s.status,
            replicas: `${s.replicas.running}/${s.replicas.desired}`,
            image: s.image,
            last_error: s.last_error ?? null,
          })),
          latest_plan: plan
            ? {
                id: plan.id,
                status: plan.status,
                plan_status: plan.plan_status,
                sha: plan.sha.slice(0, 7),
                error: plan.error,
                held: plan.actions.filter((a) => a.gate === 'confirm' && a.outcome !== 'done').map((a) => `${a.id}: ${a.reason}`),
                failed: plan.actions.filter((a) => a.outcome === 'failed').map((a) => `${a.id}: ${a.outcome_message ?? ''}`),
                config_issues: plan.issues.map((i) => `${i.severity} ${i.path}${i.line ? ` (line ${i.line})` : ''}: ${i.message}`),
              }
            : null,
          drift: app.drift?.environments.find((d) => d.environment === envName)?.changes ?? null,
          previews: app.previews.map((p) => ({ pr: p.pr, url: p.url, status: p.status })),
          ...(opts.controllerUrl ? { dashboard: `${opts.controllerUrl.replace(/\/+$/, '')}/stacks/${encodeURIComponent(stack)}` } : {}),
        };
        return ok(json(status), status);
      }),
  );

  server.registerTool(
    'logs',
    {
      title: 'Service logs',
      description:
        'The most recent log lines of one service (all its tasks, stdout and stderr, oldest first). Name the service by its short name within an app (`web`), its full name (`shop_web`), or id.',
      inputSchema: z.object({
        service: z.string().describe('Service: short name (with `app`), full name, or id.'),
        app: z.string().optional().describe('App the service belongs to, to resolve a short name.'),
        environment: z.string().optional().describe('Environment of the app. Default: production.'),
        tail: z.number().int().min(1).max(1000).optional().describe('How many lines (default 200).'),
        since_minutes: z.number().int().min(1).max(10_080).optional().describe('Only lines from the last N minutes.'),
      }),
      annotations: READ,
    },
    async ({ service, app, environment, tail, since_minutes }) =>
      guard(async () => {
        const stack = app ? appStack(await resolveApp(client, app), environment) : undefined;
        const svc = await resolveService(client, service, stack);
        const { data } = await client.services.logs(svc.id, {
          tail: tail ?? 200,
          ...(since_minutes ? { since: Math.floor(Date.now() / 1000) - since_minutes * 60 } : {}),
        });
        const text = data.map((l) => `${l.ts ? new Date(l.ts).toISOString() : ''} ${l.stream === 'stderr' ? 'ERR ' : ''}${l.message}`).join('\n');
        return ok(text || `(no log lines from ${svc.name})`);
      }),
  );

  server.registerTool(
    'env',
    {
      title: 'Service environment',
      description:
        'A service’s environment variables. Plain values are shown; secret variables and secret-looking values are listed by name only (value withheld) — this tool never reveals secrets.',
      inputSchema: z.object({
        service: z.string().describe('Service: short name (with `app`), full name, or id.'),
        app: z.string().optional(),
        environment: z.string().optional(),
      }),
      annotations: READ,
    },
    async ({ service, app, environment }) =>
      guard(async () => {
        const stack = app ? appStack(await resolveApp(client, app), environment) : undefined;
        const svc = await resolveService(client, service, stack);
        const env = await client.services.env(svc.id);
        const lines = env.vars.map((v) => `${v.key}=${v.value ?? `<${v.secret ? 'secret' : 'withheld'}${v.delivery ? `, ${v.delivery}` : ''}>`}`);
        return ok(`# ${env.service}\n${lines.join('\n')}`, env);
      }),
  );

  server.registerTool(
    'explain_error',
    {
      title: 'Explain an error',
      description:
        'Explains why something failed and what to do: pass an error text (a task error, build or crash log, an API error), or a service to have its last Swarm error and recent logs read and explained. Covers OOM kills, image pull and auth failures, crash loops, failing health checks, unschedulable services, architecture mismatches, policy denials and more.',
      inputSchema: z.object({
        text: z.string().max(100_000).optional().describe('The error or log text.'),
        service: z.string().optional().describe('Or a service to diagnose (short name with `app`, full name, or id).'),
        app: z.string().optional(),
        environment: z.string().optional(),
      }),
      annotations: READ,
    },
    async ({ text, service, app, environment }) =>
      guard(async () => {
        let corpus = text ?? '';
        if (service) {
          const stack = app ? appStack(await resolveApp(client, app), environment) : undefined;
          const svc = await resolveService(client, service, stack);
          const detail = await client.services.get(svc.id);
          const logs = await client.services.logs(svc.id, { tail: 120 }).catch(() => ({ data: [] }));
          corpus = [corpus, detail.last_error ?? '', ...logs.data.map((l) => l.message)].join('\n');
        }
        if (!corpus.trim()) throw new Error('pass `text` or `service`');
        const found = explainError(corpus);
        return ok(formatExplanations(found), { explanations: found });
      }),
  );

  if (!canWrite) return server;

  // ── mutating tools (write scope; the controller still applies ABAC) ────────

  server.registerTool(
    'deploy',
    {
      title: 'Deploy an app',
      description:
        'Plans and applies the head of a branch for an app, exactly like a git push (default: its production branch). Steps that destroy data or remove services are held for confirmation in the dashboard, never applied silently. Returns the plan. Ask the user before calling.',
      inputSchema: z.object({
        app: z.string().describe('App name, repo id, or repo full name.'),
        branch: z.string().optional().describe('Branch to deploy. Default: the production branch.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ app: ref, branch }) =>
      guard(async () => {
        const app = await resolveApp(client, ref);
        const r = await client.apps.deploy(app.repo_id, branch ? { branch } : {});
        const summary = {
          status: r.status,
          environment: r.environment,
          stack: r.stack,
          reason: r.reason,
          plan: r.plan
            ? {
                id: r.plan.id,
                status: r.plan.plan_status,
                counts: r.plan.counts,
                held: r.plan.actions.filter((a) => a.gate === 'confirm').map((a) => a.id),
                issues: r.plan.issues.map((i) => `${i.severity} ${i.path}: ${i.message}`),
              }
            : null,
        };
        return ok(r.plan?.markdown ? `${r.plan.markdown}\n\n${json(summary)}` : json(summary), summary);
      }),
  );

  server.registerTool(
    'trial_deploy',
    {
      title: 'Trial deploy (preview)',
      description:
        'Builds a branch and deploys it as a throwaway preview environment with its own URL, the same way pull-request previews work — production is untouched. Torn down automatically after the app’s preview TTL. Use it to prove a change works on swarmy before merging.',
      inputSchema: z.object({
        app: z.string().describe('App name, repo id, or repo full name.'),
        branch: z.string().describe('The branch to preview (must be pushed).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ app: ref, branch }) =>
      guard(async () => {
        const app = await resolveApp(client, ref);
        const r = await client.apps.preview(app.repo_id, branch);
        return ok(
          r.action === 'deployed' ? `Preview ${r.stack} deployed${r.url ? ` at ${r.url}` : ''}.` : `Preview ${r.action}: ${r.reason ?? ''}`,
          r,
        );
      }),
  );

  server.registerTool(
    'env_set',
    {
      title: 'Change a service’s environment',
      description:
        'Sets, rotates or removes environment variables on one service and rolls it out (a rolling update). Keys not named are kept. `secrets` are stored as Docker secrets and cannot be read back. Ask the user before calling; never invent secret values.',
      inputSchema: z.object({
        service: z.string().describe('Service: short name (with `app`), full name, or id.'),
        app: z.string().optional(),
        environment: z.string().optional(),
        set: z.record(z.string(), z.string()).optional().describe('Plain variables to add or change.'),
        secrets: z.record(z.string(), z.string()).optional().describe('Secret variables to create or rotate.'),
        unset: z.array(z.string()).optional().describe('Variable names to remove.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ service, app, environment, set, secrets, unset }) =>
      guard(async () => {
        if (!set && !secrets && !unset) throw new Error('nothing to change: pass set, secrets or unset');
        const stack = app ? appStack(await resolveApp(client, app), environment) : undefined;
        const svc = await resolveService(client, service, stack);
        const r = await client.services.patchEnv(svc.id, {
          ...(set ? { set } : {}),
          ...(secrets ? { secrets } : {}),
          ...(unset ? { unset } : {}),
        });
        return ok(`Rolling out ${svc.name}: changed ${r.changed.join(', ') || 'nothing'}.`, r);
      }),
  );

  server.registerTool(
    'telemetry_toggle',
    {
      title: 'Turn telemetry on or off',
      description:
        'Turns observability on or off for one app environment (a stack): OpenTelemetry traces, metrics and logs, collected by swarmy’s own collector. Takes effect on the next deploy of the stack. Sampling is tail-based at the collector (apps emit everything). Session replay and web analytics will join this tool when they ship. Admin/owner only.',
      inputSchema: z.object({
        stack: z.string().optional().describe('Stack name. Or give `app` (+ `environment`).'),
        app: z.string().optional(),
        environment: z.string().optional(),
        signal: z.enum(['observability']).optional().describe('What to toggle. Only `observability` today.'),
        enabled: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ stack, app, environment, enabled }) =>
      guard(async () => {
        const target = stack ?? (app ? appStack(await resolveApp(client, app), environment) : undefined);
        if (!target) throw new Error('pass `stack`, or `app` (+ `environment`)');
        const r = await client.stacks.setTelemetry(target, enabled);
        return ok(`Telemetry ${r.enabled ? 'on' : 'off'} for ${r.stack}; it applies on the next deploy.`, r);
      }),
  );

  return server;
}
