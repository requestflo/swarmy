/**
 * git-apps Phase 3 — the GitOps loop.
 *
 *   push/poll/PR ─▶ planCommit:  git.inspect @ sha → parseAppConfig → environment
 *                                for the branch → toDesired → LiveApp (ledger ∩
 *                                Docker) → planApp → AppPlan row → check run +
 *                                sticky PR comment → apply the runnable part
 *   dashboard    ─▶ confirmAppActions: ABAC per destroyed thing → re-plan the
 *                                SAME commit against today's live state → apply
 *                                with those ids confirmed
 *   worker       ─▶ pollApps / detectDrift (apps/api/src/workers/app-reconcile.ts)
 *
 * Owner decisions (2026-09): a push to a deploy branch applies immediately,
 * health-gated with auto-rollback; destructive steps always wait; a per-app
 * "require approval" toggle makes every step wait; named environments
 * (staging) are their own stacks on their own branches; Postgres defaults to
 * a single primary with nightly backups.
 *
 * One apply per app environment at a time (in-process lock); a newer commit
 * supersedes plans still waiting. Everything is org-scoped and audited; app
 * events go through `fireEvent` (build-failed / deploy-failed / app-plan /
 * app-drift).
 */
import { TRPCError } from '@trpc/server';
import {
  environmentForBranch,
  parseAppConfig,
  planApp,
  planToMarkdown,
  PRODUCTION,
  toDesired,
  type AppConfig,
  type ConfigIssue,
  type DesiredApp,
  type DesiredJob,
  type DesiredResource,
  type DesiredRoute,
  type Plan,
  type PlanAction,
} from '@swarmy/app-config';
import {
  AttachCacheInput,
  buildInventory,
  primaryDataVolumeName,
  ProvisionCacheInput,
  replicaDataVolumeName,
} from '@swarmy/core';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { evaluateAccess } from '../abac';
import { writeAudit } from './audit.service';
import { fireEvent } from './alerts-fire';
import { buildForApp, systemContext } from './cicd.service';
import { resolveManagerNode } from './dispatch.service';
import { inspectCommit, listProviderBranches } from './git-connections.service';
import { reportCommitStatus, upsertPrComment } from './git-feedback.service';
import { controllerPublicUrl } from './git-credentials';
import { deployFromCompose } from './stack.service';
import { removeService } from './service.service';
import { setServiceRoutes } from './ingress-routes-api';
import { createJob, removeJob, updateJob } from './jobs.service';
import { connectStacks, disconnectStacks } from './stack-links.service';
import {
  DEFAULT_TOPOLOGY,
  injectConnection,
  primaryServiceName,
  provisionDb,
  replicaServiceName,
  setReplicas,
  setTopology,
  walArchiveVolumeName,
} from './manageddb.service';
import {
  attachCacheToService,
  destroyCache,
  provisionCache,
  setCacheMemory,
  setCacheReplicas,
} from './cache.service';
import { attachSearchToService, destroySearch, provisionSearch } from './search.service';
import {
  attachVectorToService,
  destroyVector,
  enablePgvector,
  provisionVector,
} from './vector.service';
import { attachToService, createBucket, deleteBucket } from './buckets.service';
import { setBucketAccess } from './bucket-access.service';
import { attachSecretToService } from './secretsMgr.service';
import { parsePreviewSettings } from './previews.service';
import { applyPlan, type ActionOutcome, type AppOps } from './apps/apply';
import { appBucketName, type Attachment } from './apps/compile';
import {
  APP_STACK_LABEL,
  emptyLedger,
  parseLedger,
  readLiveApp,
  type AppLedger,
} from './apps/live';

type Deps = { db: DB; hub: AgentHub; auth: Auth };
export type AppTrigger = 'push' | 'pr' | 'manual' | 'poll' | 'drift' | 'confirm';

// ── views ────────────────────────────────────────────────────────────────────

export interface AppPlanView {
  id: string;
  repoId: string;
  environment: string;
  stack: string;
  sha: string;
  trigger: string;
  prNumber: number | null;
  status: string;
  plan: Plan | null;
  issues: ConfigIssue[];
  outcomes: Record<string, ActionOutcome>;
  error: string | null;
  confirmedIds: string[];
  markdown: string;
  createdAt: string;
  appliedAt: string | null;
}

export interface AppView {
  repoId: string;
  url: string;
  fullName: string | null;
  branch: string;
  configPath: string;
  appName: string | null;
  requireApproval: boolean;
  enforceDrift: boolean;
  environments: Array<{
    environment: string;
    branch: string;
    stack: string;
    latest: AppPlanView | null;
  }>;
  /** Live PR previews (latest plan per PR, torn-down ones excluded). */
  previews: Array<{ pr: number; stack: string; sha: string; status: string; url: string | null; updatedAt: string; planId: string }>;
  /** The last drift check (the worker refreshes it every 10 min); null = not checked yet. */
  drift: { checkedAt: string; environments: Array<{ environment: string; stack: string; changes: number }> } | null;
}

interface PlanRow {
  id: string;
  repoId: string;
  environment: string;
  stack: string;
  sha: string;
  trigger: string;
  prNumber: number;
  status: string;
  planJson: unknown;
  desiredJson: unknown;
  issuesJson: unknown;
  resultsJson: unknown;
  ledgerJson: unknown;
  error: string | null;
  confirmedIds: unknown;
  createdAt: Date;
  appliedAt: Date | null;
}

/** A JSON column holding string[] (SQLite-portable; no native arrays). */
export function stringArray(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : [];
}

function toPlanView(r: PlanRow): AppPlanView {
  const plan =
    r.planJson && typeof r.planJson === 'object' && 'actions' in (r.planJson as object)
      ? (r.planJson as Plan)
      : null;
  return {
    id: r.id,
    repoId: r.repoId,
    environment: r.environment,
    stack: r.stack,
    sha: r.sha,
    trigger: r.trigger,
    prNumber: r.prNumber || null,
    status: r.status,
    plan,
    issues: Array.isArray(r.issuesJson) ? (r.issuesJson as ConfigIssue[]) : [],
    outcomes: (r.resultsJson ?? {}) as Record<string, ActionOutcome>,
    error: r.error,
    confirmedIds: stringArray(r.confirmedIds),
    markdown: plan ? planToMarkdown(plan) : '',
    createdAt: r.createdAt.toISOString(),
    appliedAt: r.appliedAt?.toISOString() ?? null,
  };
}

// ── locking ──────────────────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();
async function withAppLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

// ── live state ───────────────────────────────────────────────────────────────

function liveServices(ctx: OrgContext) {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

async function latestLedger(
  db: DB,
  repoId: string,
  environment: string,
  prNumber: number,
): Promise<AppLedger> {
  // Newest plan that carries a ledger (JSON-null filtering isn't portable — scan a few).
  const rows = await db.appPlan.findMany({
    where: { repoId, environment, prNumber },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: { ledgerJson: true },
  });
  const row = rows.find((r) => r.ledgerJson != null);
  return row?.ledgerJson ? parseLedger(row.ledgerJson) : emptyLedger();
}

async function liveFor(ctx: OrgContext, desired: DesiredApp, ledger: AppLedger) {
  const jobs = await ctx.db.scheduledJob.findMany({
    where: { orgId: ctx.activeOrgId, stackName: desired.stack },
    select: { name: true },
  });
  const prefix = `${desired.stack}-`;
  return readLiveApp({
    stack: desired.stack,
    services: liveServices(ctx),
    ledger,
    jobNames: new Set(
      jobs.map((j) => (j.name.startsWith(prefix) ? j.name.slice(prefix.length) : j.name)),
    ),
    desiredResources: desired.resources,
  });
}

// ── the ops port, wired to the existing services ────────────────────────────

async function waitForService(ctx: OrgContext, name: string, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = liveServices(ctx).find((x) => x.name === name);
    if (s) return s;
    if (Date.now() > until)
      throw commandRejected(`service ${name} did not appear in the live inventory`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

const RELEASE_TIMEOUT_MS = 15 * 60 * 1000;

function toIngressProtection(p: DesiredRoute['protection']): Record<string, unknown> | undefined {
  if (!p) return undefined;
  return {
    ...(p.rateLimit ? { rateLimit: { ...p.rateLimit, key: 'ip' } } : {}),
    ...(p.ipAllow ? { ipAllow: p.ipAllow } : {}),
    ...(p.ipDeny ? { ipDeny: p.ipDeny } : {}),
    ...(p.countryAllow ? { countryAllow: p.countryAllow } : {}),
    ...(p.countryDeny ? { countryDeny: p.countryDeny } : {}),
    ...(p.blockBots !== undefined ? { blockBots: p.blockBots } : {}),
    ...(p.bodyMaxSize ? { bodyMaxSize: p.bodyMaxSize } : {}),
    ...(p.waf ? { waf: { blockScannerPaths: true, blockMethods: [], denyQueryPatterns: [] } } : {}),
    ...(p.cacheTtlSeconds ? { cache: { ttlSeconds: p.cacheTtlSeconds } } : {}),
  };
}

export function realOps(
  ctx: OrgContext,
  d: DesiredApp,
  repo: { id: string; branch: string },
  sha: string,
): AppOps {
  const stack = d.stack;
  const svcName = (s: string) => `${stack}_${s}`;
  return {
    async createResource(r) {
      switch (r.type) {
        case 'postgres':
          await provisionDb(ctx, {
            stack,
            name: r.name,
            replicas: r.replicas,
            database: r.database,
            ...(r.version !== 16 ? { imageTag: String(r.version) } : {}),
            autoBackup: r.backups !== null,
          });
          if (r.ha !== DEFAULT_TOPOLOGY) {
            await setTopology(ctx, {
              stack,
              cluster: r.name,
              topology: r.ha,
              ...(r.regions
                ? {
                    regions: Object.entries(r.regions).map(([region, replicas]) => ({
                      region,
                      replicas,
                    })),
                  }
                : {}),
            });
          }
          return {};
        case 'cache':
          await provisionCache(
            ctx,
            ProvisionCacheInput.parse({
              stack,
              name: r.name,
              engine: r.engine,
              topology: r.ha,
              memoryMb: r.memoryMb,
              replicas: r.replicas,
            }),
          );
          return {};
        case 'search':
          await provisionSearch(ctx, {
            stack,
            name: r.name,
            engine: r.engine as 'meilisearch' | 'typesense',
          });
          return {};
        case 'vector':
          if (r.engine === 'pgvector' && r.on) await enablePgvector(ctx, { stack, cluster: r.on });
          else await provisionVector(ctx, { stack, name: r.name });
          return {};
        case 'bucket': {
          const b = await createBucket(ctx, { name: appBucketName(stack, r.name) });
          if (r.access !== 'internal') {
            await setBucketAccess(ctx, {
              bucketId: b.id,
              mode: r.access.toUpperCase() as 'MESH' | 'PUBLIC',
              dashboardDomain: null,
            });
          }
          return { bucketId: b.id };
        }
      }
    },
    async updateResource(r, before) {
      if (r.type === 'postgres' && before?.type === 'postgres') {
        if (r.ha !== before.ha) {
          await setTopology(ctx, {
            stack,
            cluster: r.name,
            topology: r.ha,
            ...(r.regions
              ? {
                  regions: Object.entries(r.regions).map(([region, replicas]) => ({
                    region,
                    replicas,
                  })),
                }
              : {}),
          });
        }
        if (r.replicas !== before.replicas)
          await setReplicas(ctx, { stack, cluster: r.name, replicas: r.replicas });
        if (r.version !== before.version) {
          throw commandRejected(
            `postgres ${before.version} → ${r.version} needs a dump + restore — run it from the Data tab (swarmy won't do a major upgrade in place)`,
          );
        }
      } else if (r.type === 'cache' && before?.type === 'cache') {
        if (r.memoryMb !== before.memoryMb)
          await setCacheMemory(ctx, { stack, cluster: r.name, memoryMb: r.memoryMb });
        if (r.replicas !== before.replicas)
          await setCacheReplicas(ctx, { stack, cluster: r.name, replicas: r.replicas });
      } else if (r.type === 'bucket' && before?.type === 'bucket' && r.access !== before.access) {
        const led = await latestLedger(ctx.db, repo.id, d.environment, d.preview?.pr ?? 0);
        const bucketId = led.resources[r.name]?.bucketId;
        if (!bucketId) throw commandRejected(`bucket ${r.name} is not known to swarmy yet`);
        await setBucketAccess(ctx, {
          bucketId,
          mode: r.access.toUpperCase() as 'INTERNAL' | 'MESH' | 'PUBLIC',
          dashboardDomain: null,
        });
      }
      // Other in-place changes (engine switches, pgvector moves) are gated
      // `confirm` by the planner and re-created by the operator from the Data tab.
    },
    async deleteResource(name, type, before) {
      switch (type) {
        case 'postgres':
          // Stop the cluster's services; the data volume is KEPT (a restore stays possible).
          for (const n of [primaryServiceName(stack, name), replicaServiceName(stack, name)]) {
            const s = liveServices(ctx).find((x) => x.name === n);
            if (s) await removeService(ctx, s.id);
          }
          return;
        case 'cache':
          await destroyCache(ctx, { stack, cluster: name, force: true });
          return;
        case 'search':
          await destroySearch(ctx, { stack, name, force: true });
          return;
        case 'vector':
          if (before?.type === 'vector' && before.engine === 'pgvector') return; // extension stays; harmless
          await destroyVector(ctx, { stack, name, force: true });
          return;
        case 'bucket':
          if (before?.bucketId) await deleteBucket(ctx, before.bucketId); // refuses while it holds objects
          return;
      }
    },
    async build(a) {
      const b = await buildForApp(ctx, {
        repoId: repo.id,
        ref: repo.branch,
        sha,
        build: {
          ...(a.context !== '.' ? { subdir: a.context } : {}),
          ...(a.dockerfile !== 'Dockerfile' ? { dockerfile: a.dockerfile } : {}),
          ...(a.target ? { target: a.target } : {}),
          ...(Object.keys(a.args).length ? { buildArgs: a.args } : {}),
        },
      });
      if (!b.image || !b.image.includes('@sha256:'))
        throw commandRejected('the build produced no pinned digest');
      return { image: b.image };
    },
    async deploy(composeSource) {
      // git is the decision: warns pass (recorded), only a `block` refuses.
      await deployFromCompose(ctx, { name: stack, composeSource, admissionMode: 'automation' });
    },
    async attach(a: Attachment, ledger) {
      const app = await waitForService(ctx, svcName(a.service));
      switch (a.kind) {
        case 'db':
          await injectConnection(ctx, {
            stack,
            appService: app.name,
            cluster: a.cluster,
            envVar: a.envVar,
          });
          return;
        case 'cache':
          await attachCacheToService(
            ctx,
            AttachCacheInput.parse({
              stack,
              cluster: a.cluster,
              appService: app.name,
              envVar: a.envVar,
            }),
          );
          return;
        case 'search':
          await attachSearchToService(ctx, { stack, name: a.name, appService: app.name });
          return;
        case 'vector':
          await attachVectorToService(ctx, {
            stack,
            name: a.name,
            appService: app.name,
            envVar: a.envVar,
          });
          return;
        case 'bucket': {
          const bucketId = ledger.resources[a.resource]?.bucketId;
          if (!bucketId) throw commandRejected(`bucket ${a.resource} is not provisioned yet`);
          await attachToService(ctx, { bucketId, appService: app.name });
          return;
        }
        case 'secret':
          await attachSecretToService(ctx, { family: a.family, service: app.name });
          return;
      }
    },
    async runRelease(service, image, command) {
      // The release runs like the service would: its env (injected credentials
      // included) and its networks, in the NEW image, on a manager.
      const live = await waitForService(ctx, svcName(service));
      const env = Object.fromEntries(
        live.env.map((kv) => {
          const i = kv.indexOf('=');
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
      const node = await resolveManagerNode(ctx);
      let res: RunOnceResult;
      try {
        res = await ctx.hub.dispatch<RunOnceResult>(
          node.id,
          'container.runOnce',
          {
            image,
            cmd: command,
            env,
            networks: live.networks.map((n) => n.name),
            timeoutMs: RELEASE_TIMEOUT_MS,
          },
          { timeoutMs: RELEASE_TIMEOUT_MS + 30_000 },
        );
      } catch (e) {
        throw mapDispatchError(e);
      }
      if (res.exitCode !== 0 || res.timedOut) {
        throw commandRejected(
          `release ${command.join(' ')} ${res.timedOut ? 'timed out' : `exited ${res.exitCode}`}:\n${res.output.slice(-1500)}`,
        );
      }
    },
    async setRoutes(service, routes) {
      const app = await waitForService(ctx, svcName(service));
      await setServiceRoutes(
        ctx,
        app.id,
        routes.map((r) => ({
          host: r.host,
          port: r.port,
          tls: 'auto' as const,
          ...(r.path !== '/' ? { path: r.path } : {}),
          ...(r.stripPath ? { stripPrefix: true } : {}),
          ...(r.protection ? { protection: toIngressProtection(r.protection) as never } : {}),
        })),
      );
    },
    async upsertJob(j: DesiredJob, existingId) {
      const base = {
        name: `${stack}-${j.name}`.slice(0, 63),
        schedule: j.schedule,
        ...(j.image
          ? { kind: 'image' as const, image: j.image }
          : { kind: 'service-exec' as const, serviceRef: svcName(j.service ?? '') }),
        command: j.command,
        env: j.env,
        timeoutMs: Math.min(86_400_000, Math.max(1_000, j.timeoutSeconds * 1000)),
        retries: Math.min(5, j.retries),
        runOn: {},
        alertOnFailure: true,
        enabled: true,
        stackName: stack,
      };
      if (existingId) {
        const row = await updateJob(ctx, { id: existingId, ...base });
        return { jobId: row.id };
      }
      const row = await createJob(ctx, base);
      return { jobId: row.id };
    },
    async removeJob(jobId) {
      await removeJob(ctx, jobId);
    },
    async link(peer) {
      await connectStacks(ctx, { stack, peer });
    },
    async unlink(peer) {
      await disconnectStacks(ctx, { stack, peer });
    },
    async removeService(name) {
      const s = liveServices(ctx).find(
        (x) => x.name === svcName(name) && x.labels[APP_STACK_LABEL] === stack,
      );
      if (s) await removeService(ctx, s.id);
    },
    liveImage(service) {
      return liveServices(ctx).find((x) => x.name === svcName(service))?.image;
    },
  };
}

// ── planning ─────────────────────────────────────────────────────────────────

export interface PlanCommitInput {
  repoId: string;
  /** Branch the commit is on (push) or the PR's head branch. */
  ref: string;
  sha?: string | null;
  trigger: AppTrigger;
  prNumber?: number;
  /** PR base branch (previews deploy the production app definition). */
  baseRef?: string;
  changedPaths?: string[];
  /** Plan only — never apply (drift detection, dry runs). */
  dryRun?: boolean;
}

export interface PlanCommitResult {
  planId: string | null;
  status: string;
  environment: string | null;
  stack: string | null;
  reason?: string;
}

const envKey = (repoId: string, env: string, pr: number) => `${repoId}:${env}:${pr}`;

/** A push/poll/manual/PR entry point — plan the commit, then apply what may run. */
export async function planCommit(
  ctx: OrgContext,
  input: PlanCommitInput,
): Promise<PlanCommitResult> {
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: input.repoId, orgId: ctx.activeOrgId },
  });
  if (!repo) throw notFound('repo', input.repoId);

  // ① read the commit (Builder node; the controller never clones)
  const inspected = await inspectCommit(ctx, {
    repoId: repo.id,
    ref: input.sha ?? input.ref,
    paths: [repo.configPath],
    ...(input.sha ? { fallbackBranch: input.ref } : {}),
  });
  const sha = inspected.sha;
  const text = inspected.files[repo.configPath];
  const feedbackRepo = repo;
  if (text == null) {
    // Not a swarmy.yaml app (yet): callers fall back to a plain build.
    return {
      planId: null,
      status: 'no-config',
      environment: null,
      stack: null,
      reason: `no ${repo.configPath}`,
    };
  }

  // ② parse + validate
  const parsed = parseAppConfig(text);
  if (!parsed.config) {
    const row = await ctx.db.appPlan.upsert({
      where: {
        repoId_environment_sha_trigger_prNumber: {
          repoId: repo.id,
          environment: '?',
          sha,
          trigger: input.trigger,
          prNumber: input.prNumber ?? 0,
        },
      },
      create: {
        orgId: ctx.activeOrgId,
        repoId: repo.id,
        environment: '?',
        stack: '?',
        sha,
        trigger: input.trigger,
        prNumber: input.prNumber ?? 0,
        status: 'invalid',
        issuesJson: parsed.issues as never,
      },
      update: { status: 'invalid', issuesJson: parsed.issues as never },
    });
    const errors = parsed.issues.filter((i) => i.severity === 'error');
    await reportCommitStatus(ctx.db, feedbackRepo, {
      sha,
      state: 'failure',
      context: 'swarmy / plan',
      description: `${repo.configPath} has ${errors.length} error${errors.length === 1 ? '' : 's'}`,
      summary: errors
        .map((i) => `- ${repo.configPath}${i.line ? `:${i.line}` : ''} — ${i.message}`)
        .join('\n'),
    });
    void fireEvent(ctx, {
      signal: 'app-plan',
      severity: 'warning',
      resource: `repo:${repo.id}`,
      message: `${repo.configPath} at ${sha.slice(0, 7)} is invalid: ${errors[0]?.message ?? 'see the check run'}`,
    }).catch(() => undefined);
    return {
      planId: row.id,
      status: 'invalid',
      environment: null,
      stack: null,
      reason: 'invalid swarmy.yaml',
    };
  }
  const cfg = parsed.config;

  // ③ which environment does this commit deploy?
  let environment: string;
  let preview: { pr: number; baseDomain: string } | undefined;
  let previewBase: string = PRODUCTION;
  if (input.trigger === 'pr' && input.prNumber) {
    if (!cfg.previews?.enabled)
      return {
        planId: null,
        status: 'skipped',
        environment: null,
        stack: null,
        reason: 'previews are off in swarmy.yaml',
      };
    const settings = parsePreviewSettings(repo.previewsJson);
    const baseDomain = cfg.previews.base_domain ?? settings.baseDomain;
    if (!baseDomain) {
      return {
        planId: null,
        status: 'skipped',
        environment: null,
        stack: null,
        reason: 'set previews.base_domain (or the repo preview domain) first',
      };
    }
    environment = 'preview';
    preview = { pr: input.prNumber, baseDomain };
    // A PR against `staging` previews the staging definition.
    previewBase = environmentForBranch(cfg, input.baseRef ?? repo.branch, repo.branch) ?? PRODUCTION;
  } else {
    const env = environmentForBranch(cfg, input.ref, repo.branch);
    if (!env)
      return {
        planId: null,
        status: 'skipped',
        environment: null,
        stack: null,
        reason: `branch ${input.ref} deploys nothing`,
      };
    environment = env;
  }
  // Remember what the file says the app is, and which branches it deploys from.
  if (environment === PRODUCTION) {
    const envBranches = Object.values(cfg.environments ?? {}).map((e) => e.branch);
    await ctx.db.gitRepo.update({
      where: { id: repo.id },
      data: { appName: cfg.app, envBranches: envBranches as never },
    });
  }

  const desired = toDesired(cfg, preview ? { preview, environment: previewBase } : { environment });
  const prNumber = input.prNumber ?? 0;
  return withAppLock(envKey(repo.id, environment, prNumber), async () => {
    const ledger = await latestLedger(ctx.db, repo.id, environment, prNumber);
    const live = await liveFor(ctx, desired, ledger);
    const plan = planApp(desired, live, {
      ...(input.changedPaths ? { changedPaths: input.changedPaths } : {}),
      requireApproval: repo.requireApproval && environment !== 'preview',
    });
    if (input.dryRun)
      return { planId: null, status: plan.status, environment, stack: desired.stack };

    // A newer commit supersedes plans still waiting for a human.
    await ctx.db.appPlan.updateMany({
      where: {
        repoId: repo.id,
        environment,
        prNumber,
        status: { in: ['planned', 'needs-confirmation'] },
        NOT: { sha },
      },
      data: { status: 'superseded' },
    });
    const row = await ctx.db.appPlan.upsert({
      where: {
        repoId_environment_sha_trigger_prNumber: {
          repoId: repo.id,
          environment,
          sha,
          trigger: input.trigger,
          prNumber,
        },
      },
      create: {
        orgId: ctx.activeOrgId,
        repoId: repo.id,
        environment,
        stack: desired.stack,
        sha,
        trigger: input.trigger,
        prNumber,
        status:
          plan.status === 'noop' ? 'applied' : plan.status === 'blocked' ? 'blocked' : 'planned',
        planJson: plan as never,
        desiredJson: desired as never,
        issuesJson: parsed.issues as never,
        ledgerJson: ledger as never,
      },
      update: {},
    });
    if (row.status !== 'planned' && row.status !== 'blocked' && row.status !== 'applied') {
      return {
        planId: row.id,
        status: row.status,
        environment,
        stack: desired.stack,
        reason: 'already handled',
      };
    }

    const md = planToMarkdown(
      plan,
      preview
        ? { previewUrl: desired.routes[0] ? `https://${desired.routes[0].host}` : undefined }
        : {},
    );
    const planState = plan.status === 'blocked' ? 'failure' : 'success';
    await reportCommitStatus(ctx.db, feedbackRepo, {
      sha,
      state: planState,
      context:
        environment === 'preview' ? 'swarmy / preview plan' : `swarmy / plan (${environment})`,
      description:
        plan.status === 'blocked'
          ? 'Blocked — a change cannot be applied'
          : plan.status === 'needs-confirmation'
            ? `${plan.counts.confirm} change${plan.counts.confirm === 1 ? '' : 's'} need${plan.counts.confirm === 1 ? 's' : ''} you in the dashboard`
            : plan.status === 'noop'
              ? 'Nothing to change'
              : `${plan.counts.auto} change${plan.counts.auto === 1 ? '' : 's'} will apply`,
      summary: md,
      targetUrl: `${controllerPublicUrl()}/ci?plan=${row.id}`,
    });
    if (prNumber)
      await upsertPrComment(ctx.db, feedbackRepo, {
        pr: prNumber,
        key: `plan:${repo.id}`,
        body: md,
      });

    if (plan.status === 'blocked') {
      void fireEvent(ctx, {
        signal: 'app-plan',
        severity: 'warning',
        resource: `app:${desired.stack}`,
        message: `${desired.stack} @ ${sha.slice(0, 7)} is blocked: ${plan.actions.find((a) => a.gate === 'blocked')?.reason ?? ''}`,
      }).catch(() => undefined);
      return { planId: row.id, status: 'blocked', environment, stack: desired.stack };
    }
    if (plan.status === 'noop')
      return { planId: row.id, status: 'applied', environment, stack: desired.stack };

    const res = await executePlan(ctx, row.id, { plan, desired, ledger, sha, repo, confirmed: [] });
    return { planId: row.id, status: res, environment, stack: desired.stack };
  });
}

async function executePlan(
  ctx: OrgContext,
  planId: string,
  input: {
    plan: Plan;
    desired: DesiredApp;
    ledger: AppLedger;
    sha: string;
    repo: { id: string; branch: string } & Parameters<typeof reportCommitStatus>[1];
    confirmed: string[];
  },
): Promise<string> {
  const { plan, desired, sha, repo } = input;
  await ctx.db.appPlan.update({
    where: { id: planId },
    data: { status: 'applying', planJson: plan as never },
  });
  const deployContext =
    desired.environment === 'preview'
      ? 'swarmy / preview'
      : `swarmy / deploy (${desired.environment})`;
  void reportCommitStatus(ctx.db, repo, {
    sha,
    state: 'running',
    context: deployContext,
    description: `Applying to ${desired.stack}`,
  });

  const result = await applyPlan({
    plan,
    desired,
    ledger: input.ledger,
    ops: realOps(ctx, desired, repo, sha),
    confirmed: input.confirmed,
    commit: sha,
  });
  await ctx.db.appPlan.update({
    where: { id: planId },
    data: {
      status: result.status,
      ledgerJson: result.ledger as never,
      resultsJson: result.outcomes as never,
      error: result.error ?? null,
      confirmedIds: input.confirmed as never,
      ...(result.status !== 'failed' ? { appliedAt: new Date() } : {}),
    },
  });
  if (result.status !== 'failed' && desired.environment === PRODUCTION) {
    await ctx.db.gitRepo.update({ where: { id: repo.id }, data: { lastAppliedSha: sha } });
  }
  await writeAudit(ctx, {
    action: 'app.apply',
    targetType: 'appPlan',
    targetId: planId,
    actorType: ctx.user ? 'user' : 'system',
    metadata: {
      stack: desired.stack,
      sha,
      status: result.status,
      confirmed: input.confirmed,
      error: result.error ?? null,
    },
  });

  const held = Object.values(result.outcomes).filter((o) => o.status === 'held').length;
  void reportCommitStatus(ctx.db, repo, {
    sha,
    state: result.status === 'failed' ? 'failure' : 'success',
    context: deployContext,
    description:
      result.status === 'failed'
        ? `Failed: ${(result.error ?? '').slice(0, 120)}`
        : held
          ? `Applied; ${held} change${held === 1 ? '' : 's'} wait${held === 1 ? 's' : ''} for you`
          : `Live on ${desired.stack}`,
    targetUrl: `${controllerPublicUrl()}/ci?plan=${planId}`,
  });
  if (result.status === 'failed') {
    void fireEvent(ctx, {
      signal: 'deploy-failed',
      severity: 'critical',
      resource: `app:${desired.stack}`,
      message: `${desired.stack} @ ${sha.slice(0, 7)} failed to apply: ${result.error ?? ''}`.slice(
        0,
        900,
      ),
    }).catch(() => undefined);
  } else {
    void fireEvent(ctx, {
      signal: 'deploy-failed',
      severity: 'info',
      resource: `app:${desired.stack}`,
      message: `${desired.stack} @ ${sha.slice(0, 7)} applied`,
      status: 'resolved',
    }).catch(() => undefined);
    if (held) {
      void fireEvent(ctx, {
        signal: 'app-plan',
        severity: 'info',
        resource: `app:${desired.stack}`,
        message:
          `${desired.stack}: ${held} change${held === 1 ? '' : 's'} need${held === 1 ? 's' : ''} you — ${plan.actions
            .filter((a) => result.outcomes[a.id]?.status === 'held')
            .map((a) => a.reason)
            .join('; ')}`.slice(0, 900),
      }).catch(() => undefined);
    }
  }
  return result.status;
}

// ── confirming held steps ────────────────────────────────────────────────────

/** The ABAC action + resource that authorizes one held step (by what it destroys). */
export function authorizationFor(a: PlanAction, stack: string, orgId: string) {
  switch (a.kind) {
    case 'resource.delete':
    case 'resource.create': // a type swap deletes the old one
    case 'resource.update':
      return {
        action: 'data.destroy' as const,
        resource: { type: 'managedResource', id: `${stack}/${a.name}`, orgId },
      };
    case 'service.remove':
    case 'service.deploy':
      return {
        action:
          a.kind === 'service.remove' ? ('service.remove' as const) : ('stack.deploy' as const),
        resource: { type: 'service', id: `${stack}_${a.name}`, orgId },
      };
    default:
      return { action: 'stack.deploy' as const, resource: { type: 'stack', id: stack, orgId } };
  }
}

export async function confirmAppActions(
  ctx: OrgContext,
  input: { planId: string; actionIds: string[] },
): Promise<{ status: string; confirmed: string[] }> {
  const row = await ctx.db.appPlan.findFirst({
    where: { id: input.planId, orgId: ctx.activeOrgId },
  });
  if (!row) throw notFound('plan', input.planId);
  if (!['needs-confirmation', 'planned', 'failed'].includes(row.status)) {
    throw commandRejected(`this plan is ${row.status} — there is nothing to confirm`);
  }
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: row.repoId, orgId: ctx.activeOrgId },
  });
  if (!repo) throw notFound('repo', row.repoId);
  const desired = row.desiredJson as unknown as DesiredApp;

  return withAppLock(envKey(repo.id, row.environment, row.prNumber), async () => {
    // Re-plan the SAME commit against today's live state: anything already
    // done drops out; held ids are stable (`resource.delete:files`).
    const ledger = await latestLedger(ctx.db, repo.id, row.environment, row.prNumber);
    const live = await liveFor(ctx, desired, ledger);
    const plan = planApp(desired, live, {
      requireApproval: repo.requireApproval && row.environment !== 'preview',
    });
    const byId = new Map(plan.actions.map((a) => [a.id, a]));
    const confirmed: string[] = [];
    for (const id of input.actionIds) {
      const a = byId.get(id);
      if (!a || a.gate !== 'confirm') continue;
      const { action, resource } = authorizationFor(a, desired.stack, ctx.activeOrgId);
      const decision = await evaluateAccess(ctx, action, resource);
      if (decision.decision !== 'permit') {
        // Stable swarmyCode (POLICY_DENIED) so REST/SDK clients can branch on it.
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `You can't confirm "${a.reason}" (${action}).`,
          cause: { swarmyCode: 'POLICY_DENIED', policyId: decision.policyId },
        });
      }
      confirmed.push(id);
      await writeAudit(ctx, {
        action: 'app.confirm',
        targetType: 'appPlan',
        targetId: row.id,
        metadata: { step: id, reason: a.reason, authorizedBy: action },
      });
    }
    if (!confirmed.length) return { status: row.status, confirmed };
    await ctx.db.appPlan.update({ where: { id: row.id }, data: { confirmedById: ctx.user.id } });
    const status = await executePlan(ctx, row.id, {
      plan,
      desired,
      ledger,
      sha: row.sha,
      repo,
      confirmed: [...new Set([...stringArray(row.confirmedIds), ...confirmed])],
    });
    return { status, confirmed };
  });
}

// ── previews teardown ────────────────────────────────────────────────────────

/** Tear down a PR's app preview: its services and its throwaway resources. */
export async function teardownAppPreview(
  ctx: OrgContext,
  input: { repoId: string; prNumber: number },
): Promise<{ stack: string | null }> {
  const row = await ctx.db.appPlan.findFirst({
    where: { repoId: input.repoId, environment: 'preview', prNumber: input.prNumber },
    orderBy: { updatedAt: 'desc' },
  });
  if (!row) return { stack: null };
  const desired = row.desiredJson as unknown as DesiredApp;
  const ledger = parseLedger(row.ledgerJson);
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: input.repoId, orgId: ctx.activeOrgId },
  });
  if (!repo) return { stack: null };
  const ops = realOps(ctx, desired, repo, row.sha);
  for (const s of liveServices(ctx).filter((x) => x.labels[APP_STACK_LABEL] === desired.stack)) {
    await removeService(ctx, s.id).catch(() => undefined);
  }
  // Preview data is declared disposable (isolated resources); prod's is never touched here.
  if (!desired.sharedResourcesFrom) {
    for (const [name, r] of Object.entries(ledger.resources))
      await ops.deleteResource(name, r.type, r).catch(() => undefined);
  }
  await ctx.db.appPlan.updateMany({
    where: { repoId: input.repoId, environment: 'preview', prNumber: input.prNumber },
    data: { ledgerJson: emptyLedger() as never, status: 'superseded' },
  });
  await writeAudit(ctx, {
    action: 'app.preview.teardown',
    targetType: 'gitRepo',
    targetId: input.repoId,
    actorType: 'system',
    metadata: { stack: desired.stack, pr: input.prNumber },
  });
  return { stack: desired.stack };
}

/** Tear down app previews older than their swarmy.yaml `previews.ttl` (counted from the last push). */
export async function teardownExpiredAppPreviews(
  ctx: OrgContext,
  now = new Date(),
): Promise<string[]> {
  const rows = await ctx.db.appPlan.findMany({
    where: { orgId: ctx.activeOrgId, environment: 'preview', status: { not: 'superseded' } },
    orderBy: { updatedAt: 'desc' },
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.repoId}:${r.prNumber}`;
    if (!latest.has(k)) latest.set(k, r);
  }
  const torn: string[] = [];
  for (const r of latest.values()) {
    const desired = r.desiredJson as unknown as DesiredApp;
    const ttl = desired?.previews?.ttlSeconds ?? 0;
    if (!ttl || now.getTime() - r.updatedAt.getTime() < ttl * 1000) continue;
    const res = await teardownAppPreview(ctx, { repoId: r.repoId, prNumber: r.prNumber }).catch(
      () => ({ stack: null }),
    );
    if (res.stack) torn.push(res.stack);
  }
  return torn;
}

// ── reads + settings ─────────────────────────────────────────────────────────

export async function listApps(ctx: OrgContext): Promise<AppView[]> {
  const repos = await ctx.db.gitRepo.findMany({
    where: { orgId: ctx.activeOrgId, serviceId: null },
    orderBy: { createdAt: 'desc' },
  });
  const out: AppView[] = [];
  for (const r of repos) {
    const rows = await ctx.db.appPlan.findMany({
      where: { repoId: r.id, prNumber: 0, NOT: { environment: '?' } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const latestByEnv = new Map<string, PlanRow>();
    for (const row of rows)
      if (!latestByEnv.has(row.environment)) latestByEnv.set(row.environment, row);
    const envs: AppView['environments'] = [
      { environment: PRODUCTION, branch: r.branch, stack: r.appName ?? '', latest: null },
      ...stringArray(r.envBranches).map((b) => ({
        environment: '',
        branch: b,
        stack: '',
        latest: null,
      })),
    ];
    for (const [env, row] of latestByEnv) {
      const existing =
        envs.find((e) => e.environment === env) ??
        envs.find((e) => !e.environment && e.stack === '');
      const view = toPlanView(row);
      if (existing) Object.assign(existing, { environment: env, stack: row.stack, latest: view });
      else envs.push({ environment: env, branch: '', stack: row.stack, latest: view });
    }
    out.push({
      repoId: r.id,
      url: r.url,
      fullName: r.fullName,
      branch: r.branch,
      configPath: r.configPath,
      appName: r.appName,
      requireApproval: r.requireApproval,
      enforceDrift: r.enforceDrift,
      environments: envs.filter((e) => e.environment),
      previews: await previewSummaries(ctx, r.id),
      drift: driftCache.get(r.id) ?? null,
    });
  }
  return out;
}

async function previewSummaries(ctx: OrgContext, repoId: string): Promise<AppView['previews']> {
  const rows = await ctx.db.appPlan.findMany({
    where: { orgId: ctx.activeOrgId, repoId, environment: 'preview' },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  const seen = new Set<number>();
  const out: AppView['previews'] = [];
  for (const row of rows) {
    if (seen.has(row.prNumber)) continue;
    seen.add(row.prNumber);
    if (row.status === 'superseded') continue; // torn down
    const desired = row.desiredJson as unknown as DesiredApp | null;
    const host = desired?.routes?.[0]?.host;
    out.push({
      pr: row.prNumber,
      stack: row.stack,
      sha: row.sha,
      status: row.status,
      url: host ? `https://${host}` : null,
      updatedAt: row.updatedAt.toISOString(),
      planId: row.id,
    });
  }
  return out;
}

export async function listPlans(
  ctx: OrgContext,
  input: { repoId: string; environment?: string; limit?: number },
): Promise<AppPlanView[]> {
  const rows = await ctx.db.appPlan.findMany({
    where: {
      orgId: ctx.activeOrgId,
      repoId: input.repoId,
      ...(input.environment ? { environment: input.environment } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, input.limit ?? 25),
  });
  return rows.map(toPlanView);
}

export async function getPlan(ctx: OrgContext, planId: string): Promise<AppPlanView> {
  const row = await ctx.db.appPlan.findFirst({ where: { id: planId, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('plan', planId);
  return toPlanView(row);
}

export async function setRequireApproval(
  ctx: OrgContext,
  input: { repoId: string; requireApproval: boolean },
) {
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: input.repoId, orgId: ctx.activeOrgId },
  });
  if (!repo) throw notFound('repo', input.repoId);
  await ctx.db.gitRepo.update({
    where: { id: repo.id },
    data: { requireApproval: input.requireApproval },
  });
  await writeAudit(ctx, {
    action: 'app.requireApproval',
    targetType: 'gitRepo',
    targetId: repo.id,
    metadata: { requireApproval: input.requireApproval },
  });
  return { repoId: repo.id, requireApproval: input.requireApproval };
}

/** Manual "deploy the branch head now" (dashboard / REST). */
export function replan(ctx: OrgContext, input: { repoId: string; branch?: string }) {
  return (async () => {
    const repo = await ctx.db.gitRepo.findFirst({
      where: { id: input.repoId, orgId: ctx.activeOrgId },
    });
    if (!repo) throw notFound('repo', input.repoId);
    const res = await planCommit(ctx, {
      repoId: repo.id,
      ref: input.branch ?? repo.branch,
      trigger: 'manual',
    });
    return { ...res, plan: res.planId ? await getPlan(ctx, res.planId) : null };
  })();
}

/**
 * Drift: re-plan the last applied commit of each environment against live
 * state without applying. A non-empty plan with no new commit means someone
 * changed a git-owned thing outside git (or the swarm lost it) — surfaced as
 * an `app-drift` event, never silently reverted.
 */
const lastDrift = new Map<string, string>();
/** repoId → the last drift check (served on AppView without re-planning). */
const driftCache = new Map<string, NonNullable<AppView['drift']>>();

export async function detectDrift(
  ctx: OrgContext,
  repoId: string,
  opts: { notify?: boolean } = {},
): Promise<Array<{ environment: string; stack: string; changes: number }>> {
  const repo = await ctx.db.gitRepo.findFirst({ where: { id: repoId, orgId: ctx.activeOrgId } });
  if (!repo) throw notFound('repo', repoId);
  const rows = await ctx.db.appPlan.findMany({
    where: { repoId, prNumber: 0, status: { in: ['applied', 'needs-confirmation'] } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });
  const seen = new Set<string>();
  const out: Array<{ environment: string; stack: string; changes: number }> = [];
  for (const row of rows) {
    if (seen.has(row.environment)) continue;
    seen.add(row.environment);
    const desired = row.desiredJson as unknown as DesiredApp;
    if (!desired?.stack) continue;
    const ledger = parseLedger(row.ledgerJson);
    const live = await liveFor(ctx, desired, ledger);
    // changedPaths [] → only config/spec drift counts, never "rebuild".
    const plan = planApp(desired, live, { changedPaths: [] });
    const heldIds = new Set(
      Object.entries((row.resultsJson ?? {}) as Record<string, ActionOutcome>)
        .filter(([, o]) => o.status === 'held')
        .map(([id]) => id),
    );
    const changes = plan.actions.filter((a) => !heldIds.has(a.id)).length;
    if (changes) {
      out.push({ environment: row.environment, stack: desired.stack, changes });
      if (repo.enforceDrift && opts.notify !== false) {
        // Opt-in enforce: put git-owned fields back (destructive steps still wait).
        await enforceDriftFor(ctx, repo, row, desired, ledger, plan).catch(() => undefined);
        continue;
      }
      if (opts.notify === false) continue;
      const signature = plan.actions.map((a) => a.id).join('|');
      if (lastDrift.get(desired.stack) === signature) continue; // already told them about this drift
      lastDrift.set(desired.stack, signature);
      void fireEvent(ctx, {
        signal: 'app-drift',
        severity: 'warning',
        resource: `app:${desired.stack}`,
        message:
          `${desired.stack} drifted from ${repo.configPath} @ ${row.sha.slice(0, 7)}: ${plan.actions
            .filter((a) => !heldIds.has(a.id))
            .map((a) => a.reason)
            .join('; ')}`.slice(0, 900),
      }).catch(() => undefined);
    }
  }
  driftCache.set(repoId, { checkedAt: new Date().toISOString(), environments: out });
  return out;
}

async function enforceDriftFor(
  ctx: OrgContext,
  repo: Parameters<typeof executePlan>[2]['repo'] & { configPath: string },
  row: { id: string; sha: string; environment: string; prNumber: number },
  desired: DesiredApp,
  ledger: AppLedger,
  plan: Plan,
): Promise<void> {
  await withAppLock(envKey(repo.id, row.environment, row.prNumber), async () => {
    const drift = await ctx.db.appPlan.upsert({
      where: {
        repoId_environment_sha_trigger_prNumber: {
          repoId: repo.id,
          environment: row.environment,
          sha: row.sha,
          trigger: 'drift',
          prNumber: row.prNumber,
        },
      },
      create: {
        orgId: ctx.activeOrgId,
        repoId: repo.id,
        environment: row.environment,
        stack: desired.stack,
        sha: row.sha,
        trigger: 'drift',
        prNumber: row.prNumber,
        status: 'planned',
        planJson: plan as never,
        desiredJson: desired as never,
        ledgerJson: ledger as never,
      },
      update: { status: 'planned', planJson: plan as never, ledgerJson: ledger as never },
    });
    await executePlan(ctx, drift.id, { plan, desired, ledger, sha: row.sha, repo, confirmed: [] });
    void fireEvent(ctx, {
      signal: 'app-drift',
      severity: 'info',
      resource: `app:${desired.stack}`,
      message: `${desired.stack}: drift re-applied from ${repo.configPath} @ ${row.sha.slice(0, 7)} (enforce is on)`,
    }).catch(() => undefined);
  });
}

export async function setEnforceDrift(ctx: OrgContext, input: { repoId: string; enforceDrift: boolean }) {
  const repo = await ctx.db.gitRepo.findFirst({ where: { id: input.repoId, orgId: ctx.activeOrgId } });
  if (!repo) throw notFound('repo', input.repoId);
  await ctx.db.gitRepo.update({ where: { id: repo.id }, data: { enforceDrift: input.enforceDrift } });
  await writeAudit(ctx, {
    action: 'app.enforceDrift',
    targetType: 'gitRepo',
    targetId: repo.id,
    metadata: { enforceDrift: input.enforceDrift },
  });
  return { repoId: repo.id, enforceDrift: input.enforceDrift };
}

// ── deleting data permanently ────────────────────────────────────────────────

/**
 * The ONLY path that destroys a removed Postgres's data. A confirmed
 * `resource.delete` stops the cluster and keeps its volumes; this explicit
 * action — `data.destroy` + typing `<stack>/<resource>` — removes them from
 * every node. Refused while the cluster still runs or swarmy.yaml still
 * declares it.
 */
export async function purgeAppData(
  ctx: OrgContext,
  input: { repoId: string; environment: string; resource: string; confirm: string },
): Promise<{ stack: string; resource: string; volumes: string[]; nodes: number }> {
  const row = await ctx.db.appPlan.findFirst({
    where: { orgId: ctx.activeOrgId, repoId: input.repoId, environment: input.environment, prNumber: 0 },
    orderBy: { updatedAt: 'desc' },
  });
  if (!row) throw notFound('app environment', `${input.repoId}/${input.environment}`);
  const desired = row.desiredJson as unknown as DesiredApp;
  const stack = desired.stack;
  const expected = `${stack}/${input.resource}`;
  if (input.confirm !== expected) {
    throw commandRejected(`type ${expected} to delete its data permanently`);
  }
  if (desired.resources.some((r) => r.name === input.resource)) {
    throw commandRejected(`${input.resource} is still declared in swarmy.yaml — remove it there first`);
  }
  if (parseLedger(row.ledgerJson).resources[input.resource]) {
    throw commandRejected(`${input.resource} has not been removed yet — confirm its removal first`);
  }
  if (liveServices(ctx).some((s) => s.name === primaryServiceName(stack, input.resource) || s.name === replicaServiceName(stack, input.resource))) {
    throw commandRejected(`${input.resource} is still running`);
  }
  const decision = await evaluateAccess(ctx, 'data.destroy', {
    type: 'managedResource',
    id: expected,
    orgId: ctx.activeOrgId,
  });
  if (decision.decision !== 'permit') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You can't delete ${expected}'s data (data.destroy).`,
      cause: { swarmyCode: 'POLICY_DENIED', policyId: decision.policyId },
    });
  }
  const volumes = [
    primaryDataVolumeName(stack, input.resource),
    replicaDataVolumeName(stack, input.resource),
    walArchiveVolumeName(stack, input.resource),
  ];
  // Local volumes live on whichever node ran the task — ask every online node.
  const nodes = await ctx.db.node.findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true } });
  const online = nodes.filter((n) => ctx.hub.isOnline(n.id));
  for (const n of online) {
    for (const name of volumes) {
      await ctx.hub.dispatch(n.id, 'volume.remove', { name, cluster: false }).catch(() => undefined); // absent here = fine
    }
  }
  await writeAudit(ctx, {
    action: 'app.data.purge',
    targetType: 'managedResource',
    targetId: expected,
    metadata: { volumes, nodes: online.length },
  });
  return { stack, resource: input.resource, volumes, nodes: online.length };
}

// ── polling (controllers the provider can't reach, or a missed webhook) ─────

/**
 * Plan any deploy-branch head this app hasn't seen yet. One provider call
 * per repo (branch list with head shas); generic git relies on its webhook.
 * Idempotent: a sha that already has a plan is skipped, so webhooks and
 * polling never double-apply.
 */
export async function pollApp(ctx: OrgContext, repoId: string): Promise<PlanCommitResult[]> {
  const repo = await ctx.db.gitRepo.findFirst({ where: { id: repoId, orgId: ctx.activeOrgId } });
  if (!repo || !isAppBinding(repo) || !repo.connectionId) return [];
  const repoRef = repo.fullName ?? repo.externalRepoId;
  if (!repoRef) return [];
  const heads = await listProviderBranches(ctx, {
    connectionId: repo.connectionId,
    repo: repo.externalRepoId && repo.provider === 'GITLAB' ? repo.externalRepoId : repoRef,
  }).catch(() => []);
  const out: PlanCommitResult[] = [];
  for (const branch of [repo.branch, ...stringArray(repo.envBranches)]) {
    const head = heads.find((h) => h.name === branch);
    if (!head) continue;
    const seen = await ctx.db.appPlan.findFirst({
      where: { repoId: repo.id, sha: head.sha, prNumber: 0 },
      select: { id: true },
    });
    if (seen) continue;
    if (branch === repo.branch && repo.lastAppliedSha === head.sha) continue;
    out.push(
      await planCommit(ctx, { repoId: repo.id, ref: branch, sha: head.sha, trigger: 'poll' }),
    );
  }
  return out;
}

export async function listAppBindingIds(db: DB, orgId: string): Promise<string[]> {
  const rows = await db.gitRepo.findMany({
    where: { orgId, serviceId: null, appName: { not: null } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ── system entry points (webhooks / workers) ────────────────────────────────

export function planCommitForRepo(deps: Deps, orgId: string, input: PlanCommitInput) {
  return planCommit(systemContext(deps, orgId), input);
}

export function teardownAppPreviewForRepo(
  deps: Deps,
  orgId: string,
  input: { repoId: string; prNumber: number },
) {
  return teardownAppPreview(systemContext(deps, orgId), input);
}

/** Is this repo binding a swarmy.yaml app (vs a legacy build-and-redeploy-one-service repo)? */
export function isAppBinding(repo: { serviceId: string | null }): boolean {
  return repo.serviceId === null;
}

export type { AppConfig, DesiredResource };
