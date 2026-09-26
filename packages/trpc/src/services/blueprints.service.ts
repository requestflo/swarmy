import { stacks } from './apps.repo';
import { randomBytes } from 'node:crypto';
import { bindEmailToService } from './email/bind';
import {
  buildInventory,
  SECRET_ENV_VAR,
  type BlueprintDeployInput,
  type BlueprintDeployResultView,
  type BlueprintMetaView,
  type BlueprintPlanInput,
  type BlueprintPlanView,
  type BlueprintStepResultView,
  type InvService,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { autoAddressFor } from './auto-address.service';
import { chooseDataPin } from './data-pin';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { patchLiveService } from './service-patch';
import { clusterNetworkName, injectConnection, provisionDbWithPassword } from './manageddb.service';
import { attachCacheToService, provisionCache } from './cache.service';
import { attachToService as attachBucketToService, createBucket } from './buckets.service';
import {
  attachSecretToService,
} from './secretsMgr.service';
import { deployFromCompose } from './stack.service';
import { ensureBlueprintSecretFamily } from './secret-owner.service';
import { setServiceRoutes } from './ingress-routes-api';
import {
  buildPlanSummary,
  planStepView,
  substituteTokens,
  TOKEN_DB_HOST,
  TOKEN_DB_NAME,
  TOKEN_DB_PASSWORD,
  TOKEN_DB_URL,
  TOKEN_REDIS_PASSWORD,
  TOKEN_REDIS_URL,
  type BlueprintEntry,
  type PlanEnv,
  type PlanStep,
  type WireAction,
} from './blueprints/catalog';
import { ALL_BLUEPRINTS, findBlueprint } from './blueprints/registry';
import { TemplateCompileError } from './blueprints/from-app-config';
import { credentialEnvToSecrets, isCreateTimeWire, withCreateTimeWires, type CreateTimeWire } from './blueprints/create-wires';

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
 * credential: generated secrets and credential env are folded into the specs
 * the services are first created with (never the stored compose — QA-073),
 * and managed-data wiring happens post-deploy on the Docker objects.
 */

const WIRE_WAIT_TIMEOUT_MS = 30_000;
const WIRE_POLL_MS = 750;
const NETWORK_TIMEOUT_MS = 30_000;

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The whole gallery (built-in generators + the `@swarmy/templates` app catalogue). */
export function listBlueprints(_ctx: OrgContext): BlueprintMetaView[] {
  return ALL_BLUEPRINTS.map((e) => e.meta);
}

function getEntry(id: string): BlueprintEntry {
  const entry = findBlueprint(id);
  if (!entry) throw notFound('blueprint', id);
  return entry;
}

/**
 * Resolve the async facts a pure plan needs: with no domain, the primary
 * service's auto address (null when the edge IP is unknown / tunnel-only).
 */
async function planEnv(
  ctx: OrgContext,
  entry: BlueprintEntry,
  input: BlueprintPlanInput,
): Promise<PlanEnv> {
  const env: PlanEnv = {};
  if (!input.params.domain && entry.autoAddressService) {
    env.autoHost = await autoAddressFor(ctx, input.params.name, entry.autoAddressService).catch(
      () => null,
    );
  }
  if (entry.pinsVolumes) {
    try {
      const pin = chooseDataPin(ctx, (await resolveManagerNode(ctx)).id);
      if (pin) env.pinNode = pin;
    } catch {
      // No manager online: the deploy itself will fail with a clear error.
    }
  }
  return env;
}

/** Run a plan generator, mapping a template compile failure onto a 400. */
function planSteps(entry: BlueprintEntry, input: BlueprintPlanInput, env: PlanEnv): PlanStep[] {
  try {
    return entry.plan(input.params, env);
  } catch (e) {
    if (e instanceof TemplateCompileError) throw commandRejected(e.message);
    throw e;
  }
}

/** Dry-run: what a deploy WOULD create, as display-safe steps + a summary. */
export async function planBlueprint(
  ctx: OrgContext,
  input: BlueprintPlanInput,
): Promise<BlueprintPlanView> {
  const entry = getEntry(input.id);
  const env = await planEnv(ctx, entry, input);
  const steps = planSteps(entry, input, env);
  return {
    id: input.id,
    stackName: input.params.name,
    summary: buildPlanSummary(input.params.name, steps),
    steps: steps.map(planStepView),
    ...(input.params.domain ? {} : { autoHost: env.autoHost ?? null }),
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

// ── Env-merge wire ────────────────────────────────────────────────────────────

/**
 * Redeploy a live service with extra env merged over its FULL live spec
 * (`patchLiveService`: service.inspect → merge → deploy) — volumes, command,
 * placement etc. survive.
 */
async function mergeServiceEnv(
  ctx: OrgContext,
  app: InvService,
  env: Record<string, string>,
): Promise<void> {
  await patchLiveService(ctx, app, { setEnv: env });
}

/**
 * Plan steps name services by their SHORT compose key; a compose deploy names
 * the swarm service `<stack>_<short>` (docker stack convention).
 */
export function stackServiceName(stack: string, short: string): string {
  return `${stack}_${short}`;
}

// ── Step execution ────────────────────────────────────────────────────────────

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A generated secret value. Default = 32 random bytes as base64url; templates
 * ask for a shape (`hex` 64 for a 32-byte key, `alnum` for passwords that
 * must survive URLs and shell quoting). Alnum uses rejection sampling so every
 * character is uniform.
 */
export function generateSecretValue(
  format: 'hex' | 'alnum' | 'base64url' = 'base64url',
  length?: number,
): string {
  if (format === 'hex') {
    const n = length ?? 64;
    return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
  }
  if (format === 'alnum') {
    const n = length ?? 32;
    let out = '';
    while (out.length < n) {
      for (const b of randomBytes(n * 2)) {
        if (b < 248 && out.length < n) out += ALNUM[b % 62];
      }
    }
    return out;
  }
  const v = randomBytes(32).toString('base64url');
  return length ? randomBytes(Math.ceil((length * 3) / 4) + 1).toString('base64url').slice(0, length) : v;
}

interface StepContext {
  /** The blueprint being deployed — stamped as the owner of its generated secrets (QA-078). */
  blueprint: string;
  /** The whole plan: does anything besides a secret step need its generated value? */
  steps: readonly PlanStep[];
  /** `__SWARMY_*__` → resolved value (passwords, generated secrets). */
  tokens: Record<string, string>;
  /** One-time reveals surfaced ONCE in the deploy result. */
  notes: string[];
  /** Created bucket name → Garage bucket id (for the attach wire). */
  bucketIds: Record<string, string>;
  /** Created secret family → its physical Docker secret (wired at create). */
  secretNames: Record<string, string>;
  /** Tokens resolving to a credential (generated secrets) — never plain env. */
  credentialTokens?: Set<string>;
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
        ...(wire.delivery ? { delivery: wire.delivery } : {}),
      });
      // Env delivery never puts the KEY in the spec env — the shim's name list does.
      waitKeys = [wire.delivery === 'env' ? SECRET_ENV_VAR : wire.envName];
      break;
    case 'bucket': {
      const bucketId = sctx.bucketIds[wire.bucket];
      if (!bucketId) throw commandRejected(`bucket "${wire.bucket}" was not created by this plan`);
      await attachBucketToService(ctx, { bucketId, appService: wire.service });
      waitKeys = ['S3_BUCKET'];
      break;
    }
    case 'email': {
      // Best-effort for templates: with the email service off (or no verified
      // domain) the app deploys without mail, as it always did, plus a note.
      try {
        const r = await bindEmailToService(ctx, { stack, appService: wire.service, from: wire.from, env: wire.env });
        waitKeys = r.env.length ? r.env : [SECRET_ENV_VAR];
      } catch (e) {
        sctx.notes.push(
          `Email is not wired yet (${e instanceof Error ? e.message : String(e)}). Set up the email service under Email, then redeploy ${stack} to bind it.`,
        );
        return;
      }
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
      // Server-side only: the password becomes the blueprint's DB tokens, never a response.
      const res = await provisionDbWithPassword(ctx, {
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
        ...(step.payload.purpose === 'queue' ? { purpose: 'queue' as const } : {}),
      });
      sctx.tokens[TOKEN_REDIS_URL] = `redis://:${res.password}@${res.host}:${res.port}`;
      sctx.tokens[TOKEN_REDIS_PASSWORD] = res.password;
      return `${step.payload.engine} cache ${stack}/${step.payload.cluster} · ${step.payload.memoryMb} MB · ${step.payload.topology}`;
    }
    case 'bucket': {
      const bucket = await createBucket(ctx, { name: step.payload.name });
      sctx.bucketIds[step.payload.name] = bucket.id;
      return `Bucket ${bucket.name} created`;
    }
    case 'secret': {
      // Owner-labelled so stack delete removes it and a redeploy of the same
      // stack + blueprint adopts a leftover instead of failing (QA-078). An
      // adopted family keeps its value (a surviving data volume was initialised
      // with it); when the plan needs the value itself it is rotated instead.
      const { token, revealNote } = step.payload;
      const needValue =
        !!revealNote || (!!token && sctx.steps.some((s) => s !== step && JSON.stringify(s).includes(token)));
      const ensured = await ensureBlueprintSecretFamily(ctx, {
        family: step.payload.family,
        owner: { stack, blueprint: sctx.blueprint },
        generate: () => generateSecretValue(step.payload.format, step.payload.length),
        needValue,
      });
      sctx.secretNames[step.payload.family] = ensured.name;
      const value = ensured.outcome === 'adopted' ? undefined : ensured.value;
      if (step.payload.token && value !== undefined) {
        sctx.tokens[step.payload.token] = value;
        (sctx.credentialTokens ??= new Set()).add(step.payload.token);
      }
      if (step.payload.revealNote) {
        sctx.notes.push(substituteTokens(step.payload.revealNote, sctx.tokens));
      }
      return ensured.outcome === 'adopted'
        ? `Secret ${step.payload.family} reused (left by an earlier ${stack} deploy)`
        : `Secret ${step.payload.family} ${ensured.outcome === 'rotated' ? 'rotated' : 'created (v1, write-only)'}`;
    }
    case 'stack.deploy': {
      for (const net of step.payload.ensureNetworks) {
        await ensureOverlayNetwork(ctx, net);
      }
      // The compose source is credential-free by construction; deployFromCompose
      // runs the admission pipeline and records the Release snapshot.
      // Generated secrets + credential env go on the spec each service is FIRST
      // created with — a database reads its password once, on first boot, so
      // attaching it afterwards leaves it without its user (QA-073).
      // A credential in env (DB/cache password or URL, a generated secret)
      // becomes a secret delivered as env — no spec ever holds the value.
      const split = credentialEnvToSecrets(
        step.payload.wires,
        stack,
        new Set([TOKEN_DB_PASSWORD, TOKEN_DB_URL, TOKEN_REDIS_PASSWORD, TOKEN_REDIS_URL, ...(sctx.credentialTokens ?? [])]),
      );
      for (const f of split.families) {
        // Owner-labelled like the generated secrets (QA-078); the value is this
        // deploy's, so a leftover from an earlier deploy of the stack is rotated.
        const ensured = await ensureBlueprintSecretFamily(ctx, {
          family: f.family,
          owner: { stack, blueprint: sctx.blueprint },
          generate: () => substituteTokens(f.template, sctx.tokens),
          needValue: true,
        });
        sctx.secretNames[f.family] = ensured.name;
      }
      const wires = split.wires;
      const atCreate = wires.filter(
        (w): w is CreateTimeWire => isCreateTimeWire(w) && (w.type === 'env' || w.family in sctx.secretNames),
      );
      await deployFromCompose(ctx, {
        name: stack,
        composeSource: step.payload.composeSource,
        ...(atCreate.length
          ? {
              atCreate: (spec, short) =>
                withCreateTimeWires(spec, atCreate.filter((w) => w.service === short), sctx.secretNames, sctx.tokens),
            }
          : {}),
      });
      for (const w of atCreate) {
        if (w.type !== 'secret') continue;
        await writeAudit(ctx, {
          action: 'secrets.attach',
          targetType: 'secretFamily',
          targetId: w.family,
          metadata: { service: stackServiceName(stack, w.service), version: 1, envName: w.envName, delivery: w.delivery ?? 'file', atCreate: true },
        });
      }
      // Post-labels (queue defs etc.) are stamped verbatim — deliberately NO
      // token substitution so a secret can never land in a Docker label.
      const node = await resolveManagerNode(ctx);
      for (const [service, labels] of Object.entries(step.payload.postLabels)) {
        try {
          await ctx.hub.dispatch(node.id, 'service.updateLabels', {
            service: stackServiceName(stack, service),
            add: labels,
            removeKeys: [],
          });
        } catch (e) {
          throw mapDispatchError(e);
        }
      }
      for (const wire of wires) {
        if (atCreate.includes(wire as CreateTimeWire)) continue;
        await applyWire(ctx, stack, { ...wire, service: stackServiceName(stack, wire.service) }, sctx);
      }
      for (const note of step.payload.notes ?? []) {
        sctx.notes.push(substituteTokens(note, sctx.tokens));
      }
      return `Stack ${stack} deployed · ${step.payload.services.join(', ')}`;
    }
    case 'ingress.route': {
      const app = await waitForLiveService(ctx, stack, stackServiceName(stack, step.payload.service));
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
  const entry = getEntry(input.id);
  if (entry.meta.docOnly) {
    throw commandRejected(`blueprint "${input.id}" is documentation — nothing to deploy`);
  }
  const stack = input.params.name;

  // Refuse to squat an existing stack (config row or live Docker namespace).
  const existingRow = await stacks(ctx, ctx.activeOrgId).findFirst({
    where: { orgId: ctx.activeOrgId, name: stack },
    select: { id: true },
  });
  if (existingRow || liveOrgServices(ctx).some((s) => s.stack === stack)) {
    throw commandRejected(`stack "${stack}" already exists — pick another name`);
  }

  const env = await planEnv(ctx, entry, input);
  const steps = planSteps(entry, input, env);
  const sctx: StepContext = { blueprint: input.id, steps, tokens: {}, notes: [], bucketIds: {}, secretNames: {} };
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

  return {
    id: input.id,
    stackName: stack,
    ok: !failed,
    steps: results,
    url: blueprintUrl({ routedUrl: url, autoHost: env.autoHost ?? null, ok: !failed }),
    notes: sctx.notes,
  };
}

/**
 * The address a deployed blueprint answers on: its explicit domain route when
 * one was added, else (no domain given) the primary service's automatic
 * `<svc>-<stack>.<edge-ip>.sslip.io` address the plan stamped on it. Null
 * when the deploy failed or no address can be formed (tunnel / no edge IP).
 * PURE — exported for tests.
 */
export function blueprintUrl(input: { routedUrl: string | null; autoHost: string | null; ok: boolean }): string | null {
  if (!input.ok) return null;
  if (input.routedUrl) return input.routedUrl;
  return input.autoHost ? `https://${input.autoHost}` : null;
}
