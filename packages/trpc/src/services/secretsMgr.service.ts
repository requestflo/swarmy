import {
  buildInventory,
  SECRET_FAMILY_LABEL,
  SECRET_ORG_LABEL,
  SECRET_VERSION_LABEL,
  type AttachSecretInput,
  type AttachSecretResult,
  type CreateSecretFamilyInput,
  type CreateSecretResult,
  type DeleteSecretFamilyResult,
  type DetachSecretInput,
  type DetachSecretResult,
  type InvService,
  type OrphanSecretView,
  type PruneSecretVersionsResult,
  type RotateSecretInput,
  type RotateSecretResult,
  type SecretConsumerView,
  type SecretFamilyView,
  type SecretsListView,
  type SecretVersionView,
} from '@swarmy/core';
import type {
  SecretListResult,
  ServiceSpec,
  SwarmResourceInfo,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';

/**
 * Secrets manager (slice E1) — Docker secret FAMILIES with versions, rotation
 * and a live usage map.
 *
 * Everything is **Docker-truth** (docker-native-storage): a family is just the
 * set of Docker secrets labelled `swarmy.secret.family=<name>`, each carrying
 * `swarmy.secret.version=<n>` and named `<family>__v<n>` (secrets are immutable,
 * so a "rotation" is a new physical secret + redeploying every consumer onto
 * it). There is NO Prisma model; the DB never sees a value — the plaintext rides
 * the authenticated agent WS base64-encoded straight into the Docker API, is
 * never logged, and is never returned to clients after creation.
 *
 * The mount convention keeps rotation invisible to apps: refs always target
 * `/run/secrets/<family>` (target = family), so a redeploy onto v(n+1) changes
 * the source secret but not the path the app reads.
 *
 * Usage map: the live inventory's `InvService.secrets` (spec secret refs,
 * names only) matched against physical family names.
 */

// ── Pure name/label codec (unit-tested in secretsMgr.service.test.ts) ─────────

/** Docker caps secret names at 64 chars; families leave room for `__v<n>`. */
export const SECRET_NAME_MAX = 64;
const PHYSICAL_RE = /^(.+)__v(\d+)$/;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** `<family>__v<n>` — the physical Docker secret name for one version. */
export function physicalSecretName(family: string, version: number): string {
  return `${family}__v${version}`;
}

/** Parse a physical name back to `{ family, version }`, or null if unmanaged. */
export function parsePhysicalSecretName(
  name: string,
): { family: string; version: number } | null {
  const m = PHYSICAL_RE.exec(name);
  if (!m) return null;
  const version = Number.parseInt(m[2]!, 10);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { family: m[1]!, version };
}

/**
 * A usable family name: env-style charset, fits Docker's cap with the version
 * suffix, and never ends in `__v<digits>` (which would break the codec).
 */
export function isValidSecretFamily(family: string): boolean {
  if (!FAMILY_RE.test(family)) return false;
  if (family.length > SECRET_NAME_MAX - '__v'.length - 5) return false; // ≤56: room for __v + 5 digits
  return !/__v\d+$/.test(family);
}

/** Next version for a family: max(existing) + 1, starting at 1. */
export function nextSecretVersion(versions: number[]): number {
  let max = 0;
  for (const v of versions) if (Number.isSafeInteger(v) && v > max) max = v;
  return max + 1;
}

/** Stable in-container path apps read a family from (target = family name). */
export function secretMountPath(family: string): string {
  return `/run/secrets/${family}`;
}

/**
 * Rebuild a spec's secret refs from the live inventory's NAME list. Managed
 * names (`<family>__v<n>`) get `target: <family>` so the mount path stays
 * stable across rotations; unmanaged names mount under their own name.
 */
export function secretRefsFor(names: string[]): { source: string; target?: string }[] {
  return names.map((name) => {
    const parsed = parsePhysicalSecretName(name);
    return parsed ? { source: name, target: parsed.family } : { source: name };
  });
}

/** One family's physical versions as grouped off the Docker secret labels. */
export interface FamilyGroup {
  family: string;
  /** version → physical secret info (newest resolvable via versions[0]). */
  versions: { version: number; name: string; createdAt: number }[];
}

/**
 * Group a `secret.list` result into managed families (label-driven; version
 * from the label with a name-parse fallback) and unmanaged orphans (secrets
 * carrying no `swarmy.*` label at all). Org-scoped: families stamped with a
 * different `swarmy.secret.org` are ignored.
 */
export function groupSecrets(
  secrets: SwarmResourceInfo[],
  orgId: string,
): { families: FamilyGroup[]; orphans: SwarmResourceInfo[] } {
  const byFamily = new Map<string, FamilyGroup>();
  const orphans: SwarmResourceInfo[] = [];

  for (const s of secrets) {
    const labels = s.labels ?? {};
    const family = labels[SECRET_FAMILY_LABEL];
    if (family) {
      const org = labels[SECRET_ORG_LABEL];
      if (org && org !== orgId) continue;
      const fromLabel = Number.parseInt(labels[SECRET_VERSION_LABEL] ?? '', 10);
      const version = Number.isSafeInteger(fromLabel) && fromLabel >= 1
        ? fromLabel
        : (parsePhysicalSecretName(s.name)?.version ?? 1);
      const group = byFamily.get(family) ?? { family, versions: [] };
      group.versions.push({ version, name: s.name, createdAt: s.createdAt });
      byFamily.set(family, group);
      continue;
    }
    // Unmanaged = no swarmy.* label at all (managed-cache passwords etc. carry
    // swarmy.managed and stay out of both lists).
    if (!Object.keys(labels).some((k) => k.startsWith('swarmy.'))) orphans.push(s);
  }

  const families = [...byFamily.values()].map((g) => ({
    family: g.family,
    versions: [...g.versions].sort((a, b) => b.version - a.version),
  }));
  families.sort((a, b) => a.family.localeCompare(b.family));
  orphans.sort((a, b) => a.name.localeCompare(b.name));
  return { families, orphans };
}

// ── Live reads ────────────────────────────────────────────────────────────────

const DISPATCH_TIMEOUT_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 60_000;

function liveOrgServices(ctx: OrgContext): InvService[] {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  return buildInventory(services, containers).services;
}

async function listRawSecrets(ctx: OrgContext, nodeId: string): Promise<SwarmResourceInfo[]> {
  try {
    const res = await ctx.hub.dispatch<SecretListResult>(
      nodeId,
      'secret.list',
      {},
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
    return res.secrets ?? [];
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/** Consumers of any physical version, matched off live spec secret refs. */
function consumersOf(
  services: InvService[],
  group: FamilyGroup,
): { service: InvService; version: number }[] {
  const versionByName = new Map(group.versions.map((v) => [v.name, v.version]));
  const out: { service: InvService; version: number }[] = [];
  for (const s of services) {
    let best: number | undefined;
    for (const name of s.secrets ?? []) {
      const v = versionByName.get(name);
      if (v !== undefined && (best === undefined || v > best)) best = v;
    }
    if (best !== undefined) out.push({ service: s, version: best });
  }
  return out;
}

function toFamilyView(group: FamilyGroup, services: InvService[]): SecretFamilyView {
  const current = group.versions[0]!;
  const consumers = consumersOf(services, group);
  const consumerViews: SecretConsumerView[] = consumers
    .map(({ service, version }) => ({
      serviceId: service.id,
      serviceName: service.name,
      stack: service.stack,
      version,
      upToDate: version === current.version,
    }))
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));

  const versionViews: SecretVersionView[] = group.versions.map((v) => ({
    version: v.version,
    name: v.name,
    createdAt: new Date(v.createdAt).toISOString(),
    current: v.version === current.version,
    consumers: consumers
      .filter((c) => c.version === v.version)
      .map((c) => c.service.name)
      .sort(),
  }));

  return {
    family: group.family,
    currentVersion: current.version,
    versions: versionViews,
    lastRotatedAt: new Date(current.createdAt).toISOString(),
    createdAt: new Date(group.versions[group.versions.length - 1]!.createdAt).toISOString(),
    consumers: consumerViews,
    usedByCount: consumerViews.length,
    staleConsumers: consumerViews.filter((c) => !c.upToDate).length,
  };
}

/** The whole Secrets page: families (+usage) and unmanaged orphans, live. */
export async function listSecretFamilies(ctx: OrgContext): Promise<SecretsListView> {
  const node = await resolveManagerNode(ctx);
  const raw = await listRawSecrets(ctx, node.id);
  const { families, orphans } = groupSecrets(raw, ctx.activeOrgId);
  const services = liveOrgServices(ctx);

  return {
    families: families.map((g) => toFamilyView(g, services)),
    orphans: orphans.map(
      (s): OrphanSecretView => ({
        id: s.id,
        name: s.name,
        createdAt: new Date(s.createdAt).toISOString(),
        consumers: services
          .filter((svc) => (svc.secrets ?? []).includes(s.name))
          .map((svc) => svc.name)
          .sort(),
      }),
    ),
  };
}

// ── Spec rebuild (lossy-merge redeploy, mirrors cache/manageddb attach) ───────

/**
 * Rebuild an app's ServiceSpec from live truth with new env + secret refs.
 * Same lossy-merge caveat as manageddb#injectConnection: command/mounts/
 * constraints are not exposed by the live inventory and are not re-applied.
 */
function rebuildSpec(
  app: InvService,
  env: Record<string, string>,
  secretNames: string[],
): ServiceSpec {
  return {
    name: app.name,
    image: app.image,
    mode: { replicated: { replicas: app.replicas.desired } },
    // app.labels already carries com.docker.stack.namespace when stack-deployed.
    labels: { ...app.labels },
    env,
    ports: app.ports.map((p) => ({
      target: p.target,
      published: p.published,
      protocol: p.protocol === 'udp' ? ('udp' as const) : ('tcp' as const),
      mode: 'ingress' as const,
    })),
    networks: app.networks.map((n) => n.name),
    secrets: secretRefsFor(secretNames),
    ...(app.configs && app.configs.length > 0
      ? { configs: app.configs.map((n) => ({ source: n })) }
      : {}),
  };
}

function envRecord(app: InvService): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

function findApp(ctx: OrgContext, idOrName: string): InvService {
  const app = liveOrgServices(ctx).find((s) => s.id === idOrName || s.name === idOrName);
  if (!app) throw notFound('service', idOrName);
  return app;
}

async function deploy(ctx: OrgContext, nodeId: string, spec: ServiceSpec): Promise<void> {
  try {
    await ctx.hub.dispatch(
      nodeId,
      'service.deploy',
      { spec, pullPolicy: 'missing' },
      { timeoutMs: DEPLOY_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/** Swap an app onto `newName` for a family: refs + any env paths, then deploy. */
async function redeployConsumer(
  ctx: OrgContext,
  nodeId: string,
  app: InvService,
  group: FamilyGroup,
  newName: string,
): Promise<void> {
  const oldNames = new Set(group.versions.map((v) => v.name));
  const names = (app.secrets ?? []).filter((n) => !oldNames.has(n) && n !== newName);
  names.push(newName);
  // Legacy env vars that pointed at a version-suffixed path get repointed to
  // the stable family path (`target: family` makes that the real mount).
  const env = envRecord(app);
  const stablePath = secretMountPath(group.family);
  for (const [k, v] of Object.entries(env)) {
    for (const old of oldNames) {
      if (v === `/run/secrets/${old}`) env[k] = stablePath;
    }
  }
  await deploy(ctx, nodeId, rebuildSpec(app, env, names));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function requireFamily(
  ctx: OrgContext,
  nodeId: string,
  family: string,
): Promise<FamilyGroup> {
  const raw = await listRawSecrets(ctx, nodeId);
  const group = groupSecrets(raw, ctx.activeOrgId).families.find((f) => f.family === family);
  if (!group) throw notFound('secret family', family);
  return group;
}

function managedLabels(ctx: OrgContext, family: string, version: number): Record<string, string> {
  return {
    [SECRET_FAMILY_LABEL]: family,
    [SECRET_VERSION_LABEL]: String(version),
    [SECRET_ORG_LABEL]: ctx.activeOrgId,
  };
}

/**
 * Create a family at v1. The value is base64-encoded onto the wire and handed
 * to Docker — it is never persisted or logged controller-side, and the audit
 * row records only the family name and byte length.
 */
export async function createSecretFamily(
  ctx: OrgContext,
  input: CreateSecretFamilyInput,
): Promise<CreateSecretResult> {
  const family = input.family.trim();
  if (!isValidSecretFamily(family)) throw commandRejected(`invalid secret family name "${family}"`);
  const node = await resolveManagerNode(ctx);
  const raw = await listRawSecrets(ctx, node.id);
  if (groupSecrets(raw, ctx.activeOrgId).families.some((f) => f.family === family)) {
    throw commandRejected(`secret family "${family}" already exists — rotate it instead`);
  }
  const name = physicalSecretName(family, 1);
  if (raw.some((s) => s.name === name)) {
    throw commandRejected(`a Docker secret named "${name}" already exists`);
  }
  try {
    await ctx.hub.dispatch(
      node.id,
      'secret.create',
      {
        name,
        dataB64: Buffer.from(input.value, 'utf8').toString('base64'),
        labels: managedLabels(ctx, family, 1),
      },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'secrets.create',
    targetType: 'secretFamily',
    targetId: family,
    metadata: { version: 1, bytes: Buffer.byteLength(input.value, 'utf8') },
  });
  return { family, version: 1, name };
}

/**
 * Rotate: create v(n+1), then redeploy every live consumer onto the new
 * version (refs swap; the `/run/secrets/<family>` path stays stable). Old
 * versions are KEPT by default — `pruneSecretVersions` removes detached ones.
 */
export async function rotateSecretFamily(
  ctx: OrgContext,
  input: RotateSecretInput,
): Promise<RotateSecretResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const group = await requireFamily(ctx, node.id, family);
  const version = nextSecretVersion(group.versions.map((v) => v.version));
  const name = physicalSecretName(family, version);

  try {
    await ctx.hub.dispatch(
      node.id,
      'secret.create',
      {
        name,
        dataB64: Buffer.from(input.value, 'utf8').toString('base64'),
        labels: managedLabels(ctx, family, version),
      },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }

  const services = liveOrgServices(ctx);
  const consumers = consumersOf(services, group);
  const redeployed: string[] = [];
  for (const { service } of consumers) {
    await redeployConsumer(ctx, node.id, service, group, name);
    redeployed.push(service.name);
  }

  await writeAudit(ctx, {
    action: 'secrets.rotate',
    targetType: 'secretFamily',
    targetId: family,
    metadata: { version, redeployed, bytes: Buffer.byteLength(input.value, 'utf8') },
  });
  return { family, version, name, redeployed: redeployed.sort() };
}

/**
 * Attach a family's CURRENT version to a service: redeploy with the secret ref
 * mounted at the stable `/run/secrets/<family>` path (+ an optional env var
 * carrying that path, `_FILE`-style).
 */
export async function attachSecretToService(
  ctx: OrgContext,
  input: AttachSecretInput,
): Promise<AttachSecretResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const group = await requireFamily(ctx, node.id, family);
  const current = group.versions[0]!;
  const app = findApp(ctx, input.service);

  const oldNames = new Set(group.versions.map((v) => v.name));
  const names = (app.secrets ?? []).filter((n) => !oldNames.has(n));
  names.push(current.name);

  const env = envRecord(app);
  const envName = input.envName?.trim() || null;
  if (envName) env[envName] = secretMountPath(family);

  await deploy(ctx, node.id, rebuildSpec(app, env, names));
  await writeAudit(ctx, {
    action: 'secrets.attach',
    targetType: 'secretFamily',
    targetId: family,
    metadata: { service: app.name, version: current.version, envName },
  });
  return {
    family,
    service: app.name,
    version: current.version,
    mountPath: secretMountPath(family),
    envName,
  };
}

/** Detach: drop the family's refs + any env vars pointing at its mount path. */
export async function detachSecretFromService(
  ctx: OrgContext,
  input: DetachSecretInput,
): Promise<DetachSecretResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const group = await requireFamily(ctx, node.id, family);
  const app = findApp(ctx, input.service);

  const oldNames = new Set(group.versions.map((v) => v.name));
  if (!(app.secrets ?? []).some((n) => oldNames.has(n))) {
    throw commandRejected(`service "${app.name}" does not use secret "${family}"`);
  }
  const names = (app.secrets ?? []).filter((n) => !oldNames.has(n));
  const paths = new Set([
    secretMountPath(family),
    ...[...oldNames].map((n) => `/run/secrets/${n}`),
  ]);
  const env = envRecord(app);
  for (const [k, v] of Object.entries(env)) if (paths.has(v)) delete env[k];

  await deploy(ctx, node.id, rebuildSpec(app, env, names));
  await writeAudit(ctx, {
    action: 'secrets.detach',
    targetType: 'secretFamily',
    targetId: family,
    metadata: { service: app.name },
  });
  return { family, service: app.name, detached: true };
}

/** Delete a whole family — refused while ANY service still consumes it. */
export async function deleteSecretFamily(
  ctx: OrgContext,
  input: { family: string },
): Promise<DeleteSecretFamilyResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const group = await requireFamily(ctx, node.id, family);
  const consumers = consumersOf(liveOrgServices(ctx), group);
  if (consumers.length > 0) {
    throw commandRejected(
      `secret "${family}" is used by ${consumers.length} service(s): ${consumers
        .map((c) => c.service.name)
        .join(', ')} — detach them first`,
    );
  }
  const removedVersions: number[] = [];
  try {
    for (const v of group.versions) {
      await ctx.hub.dispatch(
        node.id,
        'secret.remove',
        { name: v.name },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
      removedVersions.push(v.version);
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'secrets.delete',
    targetType: 'secretFamily',
    targetId: family,
    metadata: { removedVersions },
  });
  return { family, removedVersions: removedVersions.sort((a, b) => a - b) };
}

/** Remove old versions no service references anymore (current always kept). */
export async function pruneSecretVersions(
  ctx: OrgContext,
  input: { family: string },
): Promise<PruneSecretVersionsResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const group = await requireFamily(ctx, node.id, family);
  const current = group.versions[0]!;
  const services = liveOrgServices(ctx);
  const inUse = new Set<string>();
  for (const s of services) for (const n of s.secrets ?? []) inUse.add(n);

  const removedVersions: number[] = [];
  const keptInUse: number[] = [];
  for (const v of group.versions) {
    if (v.version === current.version) continue;
    if (inUse.has(v.name)) {
      keptInUse.push(v.version);
      continue;
    }
    try {
      await ctx.hub.dispatch(
        node.id,
        'secret.remove',
        { name: v.name },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
      removedVersions.push(v.version);
    } catch (e) {
      throw mapDispatchError(e);
    }
  }
  await writeAudit(ctx, {
    action: 'secrets.pruneVersions',
    targetType: 'secretFamily',
    targetId: family,
    metadata: { removedVersions, keptInUse },
  });
  return {
    family,
    removedVersions: removedVersions.sort((a, b) => a - b),
    keptInUse: keptInUse.sort((a, b) => a - b),
    currentVersion: current.version,
  };
}
