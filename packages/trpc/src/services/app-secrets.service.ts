import { createHmac } from 'node:crypto';
import {
  appSecretLabels,
  appSecretName,
  applySecretVars,
  decodeAppSecrets,
  secretVarDelivery,
  unwrapSecretEnv,
  type AppSecretVersion,
  type EnvVar,
  type InvService,
  type RevealSecretVarView,
  type SecretDelivery,
  type SecretVarDesired,
  type ServiceSecretVarView,
  type SetSecretVarInput,
} from '@swarmy/core';
import type { SecretListResult, ServiceSpec } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { authorize } from '../abac';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { resolveExecTarget, resolveLiveService } from './live-resolve';
import { patchLiveService } from './service-patch';

/**
 * Secret app variables (write-only, Docker-secret backed) — the controller half.
 * The pure codec/planner/GC rule is `@swarmy/core` app-secrets; this module
 * creates physical versions, plans the spec patch, lists metadata and runs the
 * audited reveal.
 *
 * Invariants:
 *  - a value is only ever held in memory for the length of one request: it is
 *    base64'd straight into the agent's `secret.create` (Docker API) and is
 *    never persisted, logged, audited, labelled, put in env or on argv;
 *  - audit rows carry KEY + version (+ byte length), never the value;
 *  - reads return metadata only; the value comes back ONLY through
 *    {@link revealSecretVar}, gated on `secrets.read` and audited.
 */

const DISPATCH_TIMEOUT_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 60_000;
const REVEAL_TIMEOUT_MS = 15_000;

// ── pure ─────────────────────────────────────────────────────────────────────

/**
 * Keyed digest of a value (HMAC-SHA256 under the controller vault key, scoped
 * to service+key), so an unchanged re-paste does not rotate. `null` when the
 * vault key is not configured — then every set rotates (safe default).
 */
export function secretValueDigest(service: string, key: string, value: string): string | null {
  const k = process.env.SWARMY_SECRET_KEY;
  if (!k) return null;
  return createHmac('sha256', `swarmy.appsecret.v1:${k}`)
    .update(`${service}\u0000${key}\u0000${value}`)
    .digest('base64url')
    .slice(0, 32);
}

/** Who set a version (display; never an id we'd have to resolve). */
function actorName(ctx: OrgContext): string | null {
  const u = ctx.user as { name?: string | null; email?: string | null } | null;
  return u?.name || u?.email || null;
}

/** The versions THIS service owns (by label), newest first. */
export function versionsOf(all: readonly AppSecretVersion[], service: string): AppSecretVersion[] {
  return all.filter((v) => v.service === service);
}

/** key → the version a live spec's refs currently mount (by physical name). */
export function mountedVersions(
  versions: readonly AppSecretVersion[],
  refs: readonly string[],
): Map<string, AppSecretVersion> {
  const names = new Set(refs);
  const out = new Map<string, AppSecretVersion>();
  for (const v of versions) {
    if (!names.has(v.name)) continue;
    const cur = out.get(v.key);
    if (!cur || v.version > cur.version) out.set(v.key, v);
  }
  return out;
}

/** Split an env list into plain vars and secret upserts (empty value = keep). */
export function partitionEnv(env: readonly EnvVar[]): {
  plain: Record<string, string>;
  secrets: { key: string; value: string; delivery: SecretDelivery }[];
} {
  const plain: Record<string, string> = {};
  const secrets: { key: string; value: string; delivery: SecretDelivery }[] = [];
  for (const e of env) {
    if (e.secret) secrets.push({ key: e.key, value: e.value, delivery: e.delivery ?? 'env' });
    else plain[e.key] = e.value;
  }
  return { plain, secrets };
}

// ── live helpers ─────────────────────────────────────────────────────────────

export async function listAppSecretVersions(ctx: OrgContext, nodeId: string): Promise<AppSecretVersion[]> {
  try {
    const res = await ctx.hub.dispatch<SecretListResult>(nodeId, 'secret.list', {}, { timeoutMs: DISPATCH_TIMEOUT_MS });
    return decodeAppSecrets(res.secrets ?? [], ctx.activeOrgId);
  } catch (e) {
    throw mapDispatchError(e);
  }
}

export interface SecretUpsert {
  key: string;
  /** '' / undefined = keep the mounted value (delivery change only). */
  value?: string;
  delivery: SecretDelivery;
}

/**
 * Resolve upserts to physical secrets: an unchanged value (same keyed digest)
 * or an empty one reuses the mounted version; anything else creates
 * `<service>_<KEY>_v<N+1>`. Returns the desired entries + what was rotated.
 */
export async function materializeSecretVars(
  ctx: OrgContext,
  nodeId: string,
  service: string,
  upserts: readonly SecretUpsert[],
  owned: readonly AppSecretVersion[],
  mounted: ReadonlyMap<string, AppSecretVersion>,
): Promise<{ desired: SecretVarDesired[]; rotated: { key: string; version: number; bytes: number }[] }> {
  const desired: SecretVarDesired[] = [];
  const rotated: { key: string; version: number; bytes: number }[] = [];
  const takenNames = new Set(owned.map((v) => v.name));
  for (const u of upserts) {
    const current = mounted.get(u.key);
    if (!u.value) {
      if (!current) throw commandRejected(`secret ${u.key} has no value yet — enter one`);
      desired.push({ key: u.key, delivery: u.delivery, secretName: current.name });
      continue;
    }
    const digest = secretValueDigest(service, u.key, u.value);
    if (current && digest && current.digest === digest) {
      desired.push({ key: u.key, delivery: u.delivery, secretName: current.name });
      continue;
    }
    let version = Math.max(0, ...owned.filter((v) => v.key === u.key).map((v) => v.version)) + 1;
    let name = appSecretName(service, u.key, version);
    while (takenNames.has(name)) name = appSecretName(service, u.key, ++version);
    try {
      await ctx.hub.dispatch(
        nodeId,
        'secret.create',
        {
          name,
          dataB64: Buffer.from(u.value, 'utf8').toString('base64'),
          labels: appSecretLabels({
            service,
            key: u.key,
            version,
            orgId: ctx.activeOrgId,
            by: actorName(ctx),
            digest,
          }),
        },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
    } catch (e) {
      throw mapDispatchError(e);
    }
    takenNames.add(name);
    desired.push({ key: u.key, delivery: u.delivery, secretName: name });
    rotated.push({ key: u.key, version, bytes: Buffer.byteLength(u.value, 'utf8') });
  }
  return { desired, rotated };
}

/** The desired set a live spec already expresses (key → mounted secret + delivery). */
export function currentDesired(
  spec: ServiceSpec,
  owned: readonly AppSecretVersion[],
): SecretVarDesired[] {
  const s = unwrapSecretEnv(spec);
  const byName = new Map(owned.map((v) => [v.name, v]));
  const out: SecretVarDesired[] = [];
  for (const r of s.secrets ?? []) {
    const v = byName.get(r.source);
    if (!v) continue;
    const key = r.target ?? v.key;
    out.push({ key, secretName: r.source, delivery: secretVarDelivery(s.env, s.secretEnv, key) });
  }
  return out;
}

/**
 * Merge a live spec's secret vars with upserts/removals/demotions and apply
 * them. PURE. `demote` = keys the caller now sends as PLAIN env (the user
 * unticked "secret"): the secret goes, the plain value stays.
 */
export function planSecretSpec(
  spec: ServiceSpec,
  owned: readonly AppSecretVersion[],
  change: { upserts: readonly SecretVarDesired[]; remove?: readonly string[]; demote?: readonly string[] },
  /** The spec as LIVE (before the caller replaced env) — where kept vars' delivery is read. */
  live: ServiceSpec = spec,
): ServiceSpec {
  const drop = new Set([...(change.remove ?? []), ...(change.demote ?? [])]);
  const next = new Map<string, SecretVarDesired>();
  for (const d of currentDesired(live, owned)) if (!drop.has(d.key)) next.set(d.key, d);
  for (const d of change.upserts) next.set(d.key, d);
  const managed = new Set(owned.map((v) => v.name));
  return applySecretVars(spec, [...next.values()], managed);
}

// ── reads ────────────────────────────────────────────────────────────────────

function requireService(ctx: OrgContext, id: string): InvService {
  const svc = resolveLiveService(ctx, id);
  if (!svc) throw notFound('service', id);
  return svc;
}

/** Env record for display: the shim's name list is plumbing, not config. */
export function secretKeysFromEnv(
  env: Record<string, string>,
  secretNames: readonly string[],
  owned: readonly AppSecretVersion[] | null,
  service?: string,
): Record<string, SecretDelivery> {
  const out: Record<string, SecretDelivery> = {};
  const list = (env.SWARMY_SECRET_ENV ?? '').split(',').filter(Boolean);
  for (const k of list) out[k] = 'env';
  if (!owned) {
    // No label read: a `<KEY>_FILE=/run/secrets/<KEY>` pointer backed by one
    // of this service's own versions (`<service>_<KEY>_v<N>`) is a file var.
    for (const [k, v] of Object.entries(env)) {
      const m = /^([A-Z_][A-Z0-9_]*)_FILE$/.exec(k);
      if (!m || v !== `/run/secrets/${m[1]}` || out[m[1]!]) continue;
      if (secretNames.some((n) => n.startsWith(`${service ?? ''}_${m[1]}_v`))) out[m[1]!] = 'file';
    }
  }
  if (owned) {
    const names = new Set(secretNames);
    for (const v of owned) {
      if (!names.has(v.name) || out[v.key]) continue;
      out[v.key] = secretVarDelivery(env, list, v.key);
    }
  }
  return out;
}

/** Metadata for every secret var the service mounts — never a value. */
export async function listSecretVars(ctx: OrgContext, id: string): Promise<ServiceSecretVarView[]> {
  const svc = requireService(ctx, id);
  const node = await resolveManagerNode(ctx);
  const owned = versionsOf(await listAppSecretVersions(ctx, node.id), svc.name);
  const mounted = mountedVersions(owned, svc.secrets ?? []);
  const env: Record<string, string> = {};
  for (const kv of svc.env) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const secretEnv = (env.SWARMY_SECRET_ENV ?? '').split(',').filter(Boolean);
  return [...mounted.values()]
    .map(
      (v): ServiceSecretVarView => ({
        key: v.key,
        delivery: secretVarDelivery(env, secretEnv, v.key),
        version: v.version,
        secretName: v.name,
        updatedAt: new Date(v.createdAt).toISOString(),
        updatedBy: v.by,
        pendingCleanup: owned.filter((o) => o.key === v.key && o.name !== v.name).length,
      }),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ── mutations ────────────────────────────────────────────────────────────────

/**
 * Set (create/rotate) or re-deliver one secret var: new version → rolling
 * update onto it (mount path unchanged). The old version is removed by the
 * app-secret GC once the update converged past the health-gate window.
 */
export async function setSecretVar(
  ctx: OrgContext,
  input: SetSecretVarInput,
): Promise<{ key: string; version: number; rotated: boolean }> {
  const svc = requireService(ctx, input.id);
  const node = await resolveManagerNode(ctx);
  const owned = versionsOf(await listAppSecretVersions(ctx, node.id), svc.name);
  const mounted = mountedVersions(owned, svc.secrets ?? []);
  const { desired, rotated } = await materializeSecretVars(
    ctx,
    node.id,
    svc.name,
    [{ key: input.key, value: input.value, delivery: input.delivery }],
    owned,
    mounted,
  );
  await patchLiveService(
    ctx,
    svc,
    { transform: (spec) => planSecretSpec(spec, owned, { upserts: desired }) },
    { nodeId: node.id, timeoutMs: DEPLOY_TIMEOUT_MS },
  );
  const r = rotated[0];
  await writeAudit(ctx, {
    action: 'secrets.appVar.set',
    targetType: 'service',
    targetId: svc.id,
    metadata: {
      service: svc.name,
      key: input.key,
      delivery: input.delivery,
      rotated: Boolean(r),
      ...(r ? { version: r.version, bytes: r.bytes } : {}),
    },
  });
  return {
    key: input.key,
    version: r?.version ?? mounted.get(input.key)?.version ?? 1,
    rotated: Boolean(r),
  };
}

/** Stop mounting a secret var (its versions are GC'd after convergence). */
export async function removeSecretVar(
  ctx: OrgContext,
  input: { id: string; key: string },
): Promise<{ key: string; removed: boolean }> {
  const svc = requireService(ctx, input.id);
  const node = await resolveManagerNode(ctx);
  const owned = versionsOf(await listAppSecretVersions(ctx, node.id), svc.name);
  if (!mountedVersions(owned, svc.secrets ?? []).has(input.key)) {
    throw commandRejected(`service "${svc.name}" has no secret variable ${input.key}`);
  }
  await patchLiveService(
    ctx,
    svc,
    { transform: (spec) => planSecretSpec(spec, owned, { upserts: [], remove: [input.key] }) },
    { nodeId: node.id, timeoutMs: DEPLOY_TIMEOUT_MS },
  );
  await writeAudit(ctx, {
    action: 'secrets.appVar.remove',
    targetType: 'service',
    targetId: svc.id,
    metadata: { service: svc.name, key: input.key },
  });
  return { key: input.key, removed: true };
}

/**
 * Reveal a value — `secrets.read` (explicit; owners/admins via `*`), audited
 * on every call (the authorize permit row + a `secrets.reveal` row). Read from
 * a RUNNING task's tmpfs via a non-interactive exec (`cat /run/secrets/<KEY>`
 * — a path on argv, never the value); Docker itself never returns secret
 * data, and swarmy keeps no copy. Needs a running task and container exec on
 * its node.
 */
export async function revealSecretVar(
  ctx: OrgContext,
  input: { id: string; key: string },
): Promise<RevealSecretVarView> {
  const svc = requireService(ctx, input.id);
  await authorize(ctx, 'secrets.read', {
    type: 'service',
    id: svc.id,
    orgId: ctx.activeOrgId,
    labels: svc.labels,
  });
  const node = await resolveManagerNode(ctx);
  const owned = versionsOf(await listAppSecretVersions(ctx, node.id), svc.name);
  const current = mountedVersions(owned, svc.secrets ?? []).get(input.key);
  if (!current) throw notFound('secret variable', input.key);
  // Right after a rotation the rollout still has old-version tasks running: read
  // from the NEWEST task (the rotated spec), never whichever one comes first.
  const target = resolveExecTarget(ctx, svc.id, { newest: true });
  if (!target) throw commandRejected(`${svc.name} has no running task to read ${input.key} from — start it first`);

  let res: { exitCode: number; output?: string };
  try {
    res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      {
        target: { containerId: target.containerId },
        cmd: ['cat', `/run/secrets/${input.key}`],
        tty: false,
        stream: false,
      },
      { timeoutMs: REVEAL_TIMEOUT_MS },
    );
  } catch (e) {
    await writeAudit(ctx, {
      action: 'secrets.reveal',
      targetType: 'service',
      targetId: svc.id,
      metadata: { service: svc.name, key: input.key, version: current.version, ok: false },
    });
    throw mapDispatchError(e);
  }
  const ok = res.exitCode === 0;
  await writeAudit(ctx, {
    action: 'secrets.reveal',
    targetType: 'service',
    targetId: svc.id,
    metadata: { service: svc.name, key: input.key, version: current.version, ok },
  });
  if (!ok) {
    // The output of a failed cat is an error message, but never echo it back
    // verbatim — it could in theory carry file content.
    throw commandRejected(`could not read ${input.key} from the running task (the image may have no \`cat\`)`);
  }
  return { key: input.key, version: current.version, value: res.output ?? '' };
}
