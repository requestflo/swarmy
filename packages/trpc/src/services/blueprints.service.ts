import { randomBytes } from 'node:crypto';
import {
  buildInventory,
  type BlueprintDeployInput,
  type BlueprintDeployResultView,
  type BlueprintMetaView,
  type BlueprintPlanInput,
  type BlueprintPlanView,
  type BlueprintStepResultView,
  type InvService,
} from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { clusterNetworkName, injectConnection, provisionDb } from './manageddb.service';
import { attachCacheToService, provisionCache } from './cache.service';
import { attachToService as attachBucketToService, createBucket } from './buckets.service';
import {
  attachSecretToService,
  createSecretFamily,
  secretRefsFor,
} from './secretsMgr.service';
import { deployFromCompose } from './stack.service';
import { setServiceRoutes } from './ingress-routes-api';
import {
  buildPlanSummary,
  getBlueprint,
  planStepView,
  substituteTokens,
  BLUEPRINT_CATALOG,
  TOKEN_DB_HOST,
  TOKEN_DB_NAME,
  TOKEN_DB_PASSWORD,
  TOKEN_DB_URL,
  TOKEN_REDIS_URL,
  type PlanStep,
  type WireAction,
} from './blueprints/catalog';

/**
 * Blueprints (slice F3) — list the static catalog, dry-run a plan, and deploy
 * by executing the plan's steps sequentially through EXISTING services:
 * manageddb `provisionDb`, cache `provisionCache`, buckets `createBucket` +
 * `attachToService`, secretsMgr `createSecretFamily`/`attachSecretToService`,
 * stack `deployFromCompose` (admission pipeline + release snapshot included)
 * and the per-service ingress route label.
 *
 * State: NONE of its own. Everything a blueprint creates is owned by the
 * composed services (Docker labels/secrets, the Stack config row, Garage) —
 * blueprints only orchestrate and audit. Generated credentials live in Docker
 * (secrets or service env, the documented manageddb-inject tradeoff) and are
 * never persisted controller-side; the persisted compose source carries no
 * credential because wiring happens post-deploy on the Docker objects.
 */

const WIRE_WAIT_TIMEOUT_MS = 30_000;
const WIRE_POLL_MS = 750;
const NETWORK_TIMEOUT_MS = 30_000;

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The whole gallery (static catalog metadata). */
export function listBlueprints(_ctx: OrgContext): BlueprintMetaView[] {
  return BLUEPRINT_CATALOG.map((e) => e.meta);
}

/** Dry-run: what a deploy WOULD create, as display-safe steps + a summary. */
export function planBlueprint(_ctx: OrgContext, input: BlueprintPlanInput): BlueprintPlanView {
  const entry = getBlueprint(input.id);
  const steps = entry.plan(input.params);
  return {
    id: input.id,
    stackName: input.params.name,
    summary: buildPlanSummary(input.params.name, steps),
    steps: steps.map(planStepView),
  };
}

// ── Live-inventory helpers ────────────────────────────────────────────────────

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

function findLive(ctx: OrgContext, stack: string, name: string): InvService | undefined {
  return liveOrgServices(ctx).find((s) => s.stack === stack && s.name === name);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the live inventory until the service appears (bounded). */
async function waitForLiveService(
  ctx: OrgContext,
  stack: string,
  name: string,
): Promise<InvService | undefined> {
  const deadline = Date.now() + WIRE_WAIT_TIMEOUT_MS;
  for (;;) {
    const svc = findLive(ctx, stack, name);
    if (svc) return svc;
    if (Date.now() >= deadline) return undefined;
    await sleep(WIRE_POLL_MS);
  }
}

/**
 * Poll until the live spec carries every env key — sequential wires rebuild the
 * spec from live truth, so the next wire must see the previous one landed or it
 * would clobber it. Returns false on timeout (caller degrades to a note).
 */
async function waitForEnvKeys(
  ctx: OrgContext,
  stack: string,
  name: string,
  keys: string[],
): Promise<boolean> {
  const deadline = Date.now() + WIRE_WAIT_TIMEOUT_MS;
  for (;;) {
    const svc = findLive(ctx, stack, name);
    if (svc && keys.every((k) => svc.env.some((kv) => kv.startsWith(`${k}=`)))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(WIRE_POLL_MS);
  }
}

// ── Env-merge wire (mirrors the cache/secretsMgr lossy-merge redeploy) ────────

function envRecord(app: InvService): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

/**
 * Redeploy a live service with extra env merged over live truth. Same
 * lossy-merge caveat as manageddb#injectConnection: command/mounts/constraints
 * are not exposed by the live inventory and are not re-applied.
 */
async function mergeServiceEnv(
  ctx: OrgContext,
  app: InvService,
  env: Record<string, string>,
): Promise<void> {
  const spec: ServiceSpec = {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    labels: { ...app.labels },
    env: { ...envRecord(app), ...env },
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: app.networks.map((n) => n.name),
    secrets: secretRefsFor(app.secrets ?? []),
    ...(app.configs && app.configs.length > 0
      ? { configs: app.configs.map((n) => ({ source: n })) }
      : {}),
  };
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
  } catch (e) {
    throw mapDispatchError(e);
  }
}

// ── Step execution ────────────────────────────────────────────────────────────

interface StepContext {
  /** `__SWARMY_*__` → resolved value (passwords, generated secrets). */
  tokens: Record<string, string>;
  /** One-time reveals surfaced ONCE in the deploy result. */
  notes: string[];
  /** Created bucket name → Garage bucket id (for the attach wire). */
  bucketIds: Record<string, string>;
}

async function ensureOverlayNetwork(ctx: OrgContext, name: string): Promise<void> {
  const node = await resolveManagerNode(ctx);
  try {
    await ctx.hub.dispatch(
      node.id,
      'network.ensure',
      { name, driver: 'overlay', attachable: true, labels: { 'swarmy.managed': 'true' } },
      { timeoutMs: NETWORK_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
}

async function applyWire(
  ctx: OrgContext,
  stack: string,
  wire: WireAction,
  sctx: StepContext,
): Promise<void> {
  const app = await waitForLiveService(ctx, stack, wire.service);
  if (!app) {
    throw commandRejected(
      `service "${wire.service}" did not appear in the live inventory in time — re-run the attach from its panel`,
    );
  }
  let waitKeys: string[] = [];
  switch (wire.type) {
    case 'db':
      await injectConnection(ctx, {
        stack,
        appService: wire.service,
        cluster: wire.cluster,
        envVar: wire.envVar,
      });
      waitKeys = [wire.envVar];
      break;
    case 'cache':
      await attachCacheToService(ctx, {
        stack,
        cluster: wire.cluster,
        appService: wire.service,
        envVar: wire.envVar,
      });
      waitKeys = [wire.envVar];
      break;
    case 'secret':
      await attachSecretToService(ctx, {
        family: wire.family,
        service: wire.service,
        envName: wire.envName,
      });
      waitKeys = [wire.envName];
      break;
    case 'bucket': {
      const bucketId = sctx.bucketIds[wire.bucket];
      if (!bucketId) throw commandRejected(`bucket "${wire.bucket}" was not created by this plan`);
      await attachBucketToService(ctx, { bucketId, appService: wire.service });
      waitKeys = ['S3_BUCKET'];
      break;
    }
    case 'env': {
      const env = Object.fromEntries(
        Object.entries(wire.env).map(([k, v]) => [k, substituteTokens(v, sctx.tokens)]),
      );
      await mergeServiceEnv(ctx, app, env);
      waitKeys = Object.keys(wire.env);
      break;
    }
  }
  // Sequential wires rebuild from live truth — wait for this one to surface so
  // the next never clobbers it. On timeout, degrade to a note (never a secret).
  const converged = await waitForEnvKeys(ctx, stack, wire.service, waitKeys);
  if (!converged) {
    sctx.notes.push(`Wiring on ${wire.service} is still converging — check its panel in a minute.`);
  }
}

/** Execute one plan step; returns the human detail line (never a credential). */
async function runStep(
  ctx: OrgContext,
  stack: string,
  step: PlanStep,
  sctx: StepContext,
): Promise<string> {
  switch (step.kind) {
    case 'db.provision': {
      // provisionDb attaches members to the per-cluster overlay network but does
      // not create it — ensure it first (same pattern as cache provisioning).
      await ensureOverlayNetwork(ctx, clusterNetworkName(stack, step.payload.cluster));
      const res = await provisionDb(ctx, {
        stack,
        name: step.payload.cluster,
        replicas: step.payload.replicas,
        database: step.payload.database,
      });
      sctx.tokens[TOKEN_DB_URL] =
        `postgres://postgres:${res.password}@${res.rwHost}:5432/${step.payload.database}`;
      sctx.tokens[TOKEN_DB_HOST] = res.rwHost;
      sctx.tokens[TOKEN_DB_PASSWORD] = res.password;
      sctx.tokens[TOKEN_DB_NAME] = step.payload.database;
      return `Postgres cluster ${stack}/${step.payload.cluster} · ${step.payload.replicas} read replica${step.payload.replicas === 1 ? '' : 's'} · host ${res.rwHost}`;
    }
    case 'cache.provision': {
      const res = await provisionCache(ctx, {
        stack,
        name: step.payload.cluster,
        engine: step.payload.engine,
        topology: step.payload.topology,
        memoryMb: step.payload.memoryMb,
        replicas: step.payload.replicas,
        regions: [],
      });
      sctx.tokens[TOKEN_REDIS_URL] = `redis://:${res.password}@${res.host}:${res.port}`;
      return `${step.payload.engine} cache ${stack}/${step.payload.cluster} · ${step.payload.memoryMb} MB · ${step.payload.topology}`;
    }
    case 'bucket': {
      const bucket = await createBucket(ctx, { name: step.payload.name });
      sctx.bucketIds[step.payload.name] = bucket.id;
      return `Bucket ${bucket.name} created`;
    }
    case 'secret': {
      const value = randomBytes(32).toString('base64url');
      await createSecretFamily(ctx, { family: step.payload.family, value });
      if (step.payload.token) sctx.tokens[step.payload.token] = value;
      if (step.payload.revealNote) {
        sctx.notes.push(substituteTokens(step.payload.revealNote, sctx.tokens));
      }
      return `Secret ${step.payload.family} created (v1, write-only)`;
    }
    case 'stack.deploy': {
      for (const net of step.payload.ensureNetworks) {
        await ensureOverlayNetwork(ctx, net);
      }
      // The compose source is credential-free by construction; deployFromCompose
      // runs the admission pipeline and records the Release snapshot.
      await deployFromCompose(ctx, { name: stack, composeSource: step.payload.composeSource });
      // Post-labels (queue defs etc.) are stamped verbatim — deliberately NO
      // token substitution so a secret can never land in a Docker label.
      const node = await resolveManagerNode(ctx);
      for (const [service, labels] of Object.entries(step.payload.postLabels)) {
        try {
          await ctx.hub.dispatch(node.id, 'service.updateLabels', {
            service,
            add: labels,
            removeKeys: [],
          });
        } catch (e) {
          throw mapDispatchError(e);
        }
      }
      for (const wire of step.payload.wires) {
        await applyWire(ctx, stack, wire, sctx);
      }
      return `Stack ${stack} deployed · ${step.payload.services.join(', ')}`;
    }
    case 'ingress.route': {
      const app = await waitForLiveService(ctx, stack, step.payload.service);
      if (!app) {
        throw commandRejected(
          `service "${step.payload.service}" is not visible yet — add the route from the Ingress page`,
        );
      }
      await setServiceRoutes(ctx, app.id, [
        { host: step.payload.host, port: step.payload.port, tls: 'auto' },
      ]);
      return `https://${step.payload.host} → ${step.payload.service}:${step.payload.port}`;
    }
  }
}

// ── Deploy ────────────────────────────────────────────────────────────────────

/**
 * Execute a blueprint: steps run sequentially, each result returned
 * synchronously; the first failure marks the rest skipped. Audited (step
 * outcomes only — never a value).
 */
export async function deployBlueprint(
  ctx: OrgContext,
  input: BlueprintDeployInput,
): Promise<BlueprintDeployResultView> {
  const entry = getBlueprint(input.id);
  if (entry.meta.docOnly) {
    throw commandRejected(`blueprint "${input.id}" is documentation — nothing to deploy`);
  }
  const stack = input.params.name;

  // Refuse to squat an existing stack (config row or live Docker namespace).
  const existingRow = await ctx.db.stack.findFirst({
    where: { orgId: ctx.activeOrgId, name: stack },
    select: { id: true },
  });
  if (existingRow || liveOrgServices(ctx).some((s) => s.stack === stack)) {
    throw commandRejected(`stack "${stack}" already exists — pick another name`);
  }

  const steps = entry.plan(input.params);
  const sctx: StepContext = { tokens: {}, notes: [], bucketIds: {} };
  const results: BlueprintStepResultView[] = [];
  let failed = false;
  let url: string | null = null;

  for (const step of steps) {
    if (failed) {
      results.push({ kind: step.kind, label: step.label, status: 'skipped', detail: null, error: null });
      continue;
    }
    try {
      const detail = await runStep(ctx, stack, step, sctx);
      results.push({ kind: step.kind, label: step.label, status: 'succeeded', detail, error: null });
      if (step.kind === 'ingress.route') url = `https://${step.payload.host}`;
    } catch (e) {
      failed = true;
      const message = e instanceof Error ? e.message : String(e);
      results.push({ kind: step.kind, label: step.label, status: 'failed', detail: null, error: message });
    }
  }

  await writeAudit(ctx, {
    action: 'blueprints.deploy',
    targetType: 'blueprint',
    targetId: input.id,
    metadata: {
      stack,
      size: input.params.size,
      domain: input.params.domain ?? null,
      ok: !failed,
      steps: results.map((r) => ({ kind: r.kind, status: r.status })),
    },
  });

  return { id: input.id, stackName: stack, ok: !failed, steps: results, url, notes: sctx.notes };
}
