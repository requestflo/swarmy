import {
  buildInventory,
  CONFIG_FAMILY_LABEL,
  CONFIG_MOUNT_LABEL,
  CONFIG_ORG_LABEL,
  CONFIG_VERSION_LABEL,
  type ApplyConfigResult,
  type ApplyConfigVersionInput,
  type AttachConfigInput,
  type AttachConfigResult,
  type ConfigConsumerView,
  type ConfigContentView,
  type ConfigFamilyView,
  type ConfigRestartPreviewInput,
  type ConfigRestartPreviewView,
  type ConfigsListView,
  type ConfigVersionView,
  type CreateConfigFamilyInput,
  type CreateConfigResult,
  type DeleteConfigFamilyResult,
  type DetachConfigInput,
  type DetachConfigResult,
  type GetConfigContentInput,
  type InvService,
  type NewConfigVersionInput,
  type NewConfigVersionResult,
  type OrphanConfigView,
  type PruneConfigVersionsResult,
} from '@swarmy/core';
import type {
  ConfigInspectResult,
  ConfigListResult,
  ServiceSpec,
  SwarmResourceInfo,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { secretRefsFor } from './secretsMgr.service';

/**
 * Configs manager (slice E2) — Docker config FAMILIES with versions, readable
 * content, diff-driven edits, apply/rollback and a live usage map.
 *
 * Everything is **Docker-truth** (docker-native-storage): a family is the set
 * of Docker configs labelled `swarmy.config.family=<name>`, each carrying
 * `swarmy.config.version=<n>` and named `<family>__v<n>` (configs are
 * immutable — an "edit" is a new physical config; "apply" redeploys consumers
 * onto a chosen version, which doubles as rollback when the version is older).
 * There is NO Prisma model. Unlike secrets, content IS readable: the agent's
 * `config.inspect` returns `Spec.Data` base64, so the UI can show and diff it.
 *
 * The mount convention keeps edits invisible to apps: config refs always
 * target the family's stable mount path (`swarmy.config.path` label, default
 * `/<family>`), so applying a different version swaps the bytes, not the path.
 *
 * Usage map: the live inventory's `InvService.configs` (spec config refs,
 * names only) matched against physical family names.
 */

// ── Pure name/label codec (unit-tested in configsMgr.service.test.ts) ─────────

/** Docker caps config names at 64 chars; families leave room for `__v<n>`. */
export const CONFIG_NAME_MAX = 64;
const PHYSICAL_RE = /^(.+)__v(\d+)$/;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** `<family>__v<n>` — the physical Docker config name for one version. */
export function physicalConfigName(family: string, version: number): string {
  return `${family}__v${version}`;
}

/** Parse a physical name back to `{ family, version }`, or null if unmanaged. */
export function parsePhysicalConfigName(
  name: string,
): { family: string; version: number } | null {
  const m = PHYSICAL_RE.exec(name);
  if (!m) return null;
  const version = Number.parseInt(m[2]!, 10);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { family: m[1]!, version };
}

/**
 * A usable family name: env/file-style charset, fits Docker's cap with the
 * version suffix, and never ends in `__v<digits>` (which would break parsing).
 */
export function isValidConfigFamily(family: string): boolean {
  if (!FAMILY_RE.test(family)) return false;
  if (family.length > CONFIG_NAME_MAX - '__v'.length - 5) return false; // ≤56: room for __v + 5 digits
  return !/__v\d+$/.test(family);
}

/** Next version for a family: max(existing) + 1, starting at 1. */
export function nextConfigVersion(versions: number[]): number {
  let max = 0;
  for (const v of versions) if (Number.isSafeInteger(v) && v > max) max = v;
  return max + 1;
}

/** Docker's own convention for a config named `<family>`: mounted at `/<family>`. */
export function defaultConfigMountPath(family: string): string {
  return `/${family}`;
}

/**
 * Rebuild a spec's config refs from the live inventory's NAME list. Managed
 * names (`<family>__v<n>`) get `target: <mountPath>` so the in-container path
 * stays stable across versions; unmanaged names keep Docker's default mount.
 */
export function configRefsFor(
  names: string[],
  mountPaths: Map<string, string>,
): { source: string; target?: string }[] {
  return names.map((name) => {
    const parsed = parsePhysicalConfigName(name);
    if (!parsed) return { source: name };
    return {
      source: name,
      target: mountPaths.get(parsed.family) ?? defaultConfigMountPath(parsed.family),
    };
  });
}

/** One family's physical versions as grouped off the Docker config labels. */
export interface ConfigFamilyGroup {
  family: string;
  /** Stable mount path (newest version's `swarmy.config.path`, else default). */
  mountPath: string;
  /** Newest first. */
  versions: { version: number; name: string; createdAt: number }[];
}

/**
 * Group a `config.list` result into managed families (label-driven; version
 * from the label with a name-parse fallback) and unmanaged orphans (configs
 * carrying no `swarmy.*` label at all). Org-scoped: families stamped with a
 * different `swarmy.config.org` are ignored.
 */
export function groupConfigs(
  configs: SwarmResourceInfo[],
  orgId: string,
): { families: ConfigFamilyGroup[]; orphans: SwarmResourceInfo[] } {
  const byFamily = new Map<
    string,
    { versions: { version: number; name: string; createdAt: number; mountPath?: string }[] }
  >();
  const orphans: SwarmResourceInfo[] = [];

  for (const c of configs) {
    const labels = c.labels ?? {};
    const family = labels[CONFIG_FAMILY_LABEL];
    if (family) {
      const org = labels[CONFIG_ORG_LABEL];
      if (org && org !== orgId) continue;
      const fromLabel = Number.parseInt(labels[CONFIG_VERSION_LABEL] ?? '', 10);
      const version = Number.isSafeInteger(fromLabel) && fromLabel >= 1
        ? fromLabel
        : (parsePhysicalConfigName(c.name)?.version ?? 1);
      const group = byFamily.get(family) ?? { versions: [] };
      group.versions.push({
        version,
        name: c.name,
        createdAt: c.createdAt,
        mountPath: labels[CONFIG_MOUNT_LABEL] || undefined,
      });
      byFamily.set(family, group);
      continue;
    }
    // Unmanaged = no swarmy.* label at all (rendered ingress configs etc. carry
    // swarmy labels and stay out of both lists).
    if (!Object.keys(labels).some((k) => k.startsWith('swarmy.'))) orphans.push(c);
  }

  const families: ConfigFamilyGroup[] = [...byFamily.entries()].map(([family, g]) => {
    const versions = [...g.versions].sort((a, b) => b.version - a.version);
    return {
      family,
      mountPath: versions[0]?.mountPath ?? defaultConfigMountPath(family),
      versions: versions.map(({ version, name, createdAt }) => ({ version, name, createdAt })),
    };
  });
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

async function listRawConfigs(ctx: OrgContext, nodeId: string): Promise<SwarmResourceInfo[]> {
  try {
    const res = await ctx.hub.dispatch<ConfigListResult>(
      nodeId,
      'config.list',
      {},
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
    return res.configs ?? [];
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/** Consumers of any physical version, matched off live spec config refs. */
function consumersOf(
  services: InvService[],
  group: ConfigFamilyGroup,
): { service: InvService; version: number }[] {
  const versionByName = new Map(group.versions.map((v) => [v.name, v.version]));
  const out: { service: InvService; version: number }[] = [];
  for (const s of services) {
    let best: number | undefined;
    for (const name of s.configs ?? []) {
      const v = versionByName.get(name);
      if (v !== undefined && (best === undefined || v > best)) best = v;
    }
    if (best !== undefined) out.push({ service: s, version: best });
  }
  return out;
}

function toConsumerViews(
  consumers: { service: InvService; version: number }[],
  currentVersion: number,
): ConfigConsumerView[] {
  return consumers
    .map(({ service, version }) => ({
      serviceId: service.id,
      serviceName: service.name,
      stack: service.stack,
      version,
      upToDate: version === currentVersion,
    }))
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}

function toFamilyView(group: ConfigFamilyGroup, services: InvService[]): ConfigFamilyView {
  const current = group.versions[0]!;
  const consumers = consumersOf(services, group);
  const consumerViews = toConsumerViews(consumers, current.version);

  const versionViews: ConfigVersionView[] = group.versions.map((v) => ({
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
    mountPath: group.mountPath,
    versions: versionViews,
    lastUpdatedAt: new Date(current.createdAt).toISOString(),
    createdAt: new Date(group.versions[group.versions.length - 1]!.createdAt).toISOString(),
    consumers: consumerViews,
    usedByCount: consumerViews.length,
    staleConsumers: consumerViews.filter((c) => !c.upToDate).length,
  };
}

/** The whole Configs page: families (+usage) and unmanaged orphans, live. */
export async function listConfigFamilies(ctx: OrgContext): Promise<ConfigsListView> {
  const node = await resolveManagerNode(ctx);
  const raw = await listRawConfigs(ctx, node.id);
  const { families, orphans } = groupConfigs(raw, ctx.activeOrgId);
  const services = liveOrgServices(ctx);

  return {
    families: families.map((g) => toFamilyView(g, services)),
    orphans: orphans.map(
      (c): OrphanConfigView => ({
        id: c.id,
        name: c.name,
        createdAt: new Date(c.createdAt).toISOString(),
        consumers: services
          .filter((svc) => (svc.configs ?? []).includes(c.name))
          .map((svc) => svc.name)
          .sort(),
      }),
    ),
  };
}

async function requireFamily(
  ctx: OrgContext,
  nodeId: string,
): Promise<{ raw: SwarmResourceInfo[]; families: ConfigFamilyGroup[] }> {
  const raw = await listRawConfigs(ctx, nodeId);
  return { raw, families: groupConfigs(raw, ctx.activeOrgId).families };
}

function findFamily(families: ConfigFamilyGroup[], family: string): ConfigFamilyGroup {
  const group = families.find((f) => f.family === family);
  if (!group) throw notFound('config family', family);
  return group;
}

/** Stable mount path for every managed family — feeds spec rebuilds. */
function mountPathsOf(families: ConfigFamilyGroup[]): Map<string, string> {
  return new Map(families.map((f) => [f.family, f.mountPath]));
}

/** Decoded content of one version (current when unspecified). Configs are readable. */
export async function getConfigContent(
  ctx: OrgContext,
  input: GetConfigContentInput,
): Promise<ConfigContentView> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const current = group.versions[0]!;
  const target =
    input.version === undefined
      ? current
      : group.versions.find((v) => v.version === input.version);
  if (!target) throw notFound('config version', `${family} v${input.version}`);

  let res: ConfigInspectResult;
  try {
    res = await ctx.hub.dispatch<ConfigInspectResult>(
      node.id,
      'config.inspect',
      { name: target.name },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }

  return {
    family,
    version: target.version,
    name: target.name,
    content: Buffer.from(res.dataB64 ?? '', 'base64').toString('utf8'),
    mountPath: group.mountPath,
    createdAt: new Date(target.createdAt).toISOString(),
    current: target.version === current.version,
  };
}

/** Dry-run of apply — exactly who restarts moving onto `version` (default current). */
export async function restartPreview(
  ctx: OrgContext,
  input: ConfigRestartPreviewInput,
): Promise<ConfigRestartPreviewView> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const current = group.versions[0]!;
  const targetVersion = input.version ?? current.version;
  if (!group.versions.some((v) => v.version === targetVersion)) {
    throw notFound('config version', `${family} v${targetVersion}`);
  }
  const consumers = toConsumerViews(
    consumersOf(liveOrgServices(ctx), group),
    current.version,
  );
  return {
    family,
    targetVersion,
    restarting: consumers.filter((c) => c.version !== targetVersion),
    upToDate: consumers.filter((c) => c.version === targetVersion),
  };
}

// ── Spec rebuild (lossy-merge redeploy, mirrors secretsMgr/manageddb) ─────────

/**
 * Rebuild an app's ServiceSpec from live truth with new config refs. Secret
 * refs are rebuilt through the secrets-manager codec so rotation-stable
 * targets survive. Same lossy-merge caveat as manageddb#injectConnection:
 * command/mounts/constraints are not exposed by the live inventory and are
 * not re-applied.
 */
function rebuildSpec(
  app: InvService,
  configNames: string[],
  mountPaths: Map<string, string>,
): ServiceSpec {
  const env: Record<string, string> = {};
  for (const kv of app.env) {
    const i = kv.indexOf('=');
    env[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
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
    secrets: secretRefsFor(app.secrets ?? []),
    configs: configRefsFor(configNames, mountPaths),
  };
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

/** Swap an app onto one physical version of a family, then redeploy. */
async function redeployConsumer(
  ctx: OrgContext,
  nodeId: string,
  app: InvService,
  group: ConfigFamilyGroup,
  newName: string,
  mountPaths: Map<string, string>,
): Promise<void> {
  const oldNames = new Set(group.versions.map((v) => v.name));
  const names = (app.configs ?? []).filter((n) => !oldNames.has(n) && n !== newName);
  names.push(newName);
  await deploy(ctx, nodeId, rebuildSpec(app, names, mountPaths));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

function managedLabels(
  ctx: OrgContext,
  family: string,
  version: number,
  mountPath: string,
): Record<string, string> {
  return {
    [CONFIG_FAMILY_LABEL]: family,
    [CONFIG_VERSION_LABEL]: String(version),
    [CONFIG_ORG_LABEL]: ctx.activeOrgId,
    [CONFIG_MOUNT_LABEL]: mountPath,
  };
}

async function createPhysical(
  ctx: OrgContext,
  nodeId: string,
  name: string,
  content: string,
  labels: Record<string, string>,
): Promise<void> {
  try {
    await ctx.hub.dispatch(
      nodeId,
      'config.create',
      { name, dataB64: Buffer.from(content, 'utf8').toString('base64'), labels },
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/** Create a family at v1. Nothing restarts — attach/apply do that explicitly. */
export async function createConfigFamily(
  ctx: OrgContext,
  input: CreateConfigFamilyInput,
): Promise<CreateConfigResult> {
  const family = input.family.trim();
  if (!isValidConfigFamily(family)) throw commandRejected(`invalid config family name "${family}"`);
  const node = await resolveManagerNode(ctx);
  const { raw, families } = await requireFamily(ctx, node.id);
  if (families.some((f) => f.family === family)) {
    throw commandRejected(`config family "${family}" already exists — edit it instead`);
  }
  const name = physicalConfigName(family, 1);
  if (raw.some((c) => c.name === name)) {
    throw commandRejected(`a Docker config named "${name}" already exists`);
  }
  const mountPath = input.mountPath?.trim() || defaultConfigMountPath(family);
  await createPhysical(ctx, node.id, name, input.content, managedLabels(ctx, family, 1, mountPath));
  await writeAudit(ctx, {
    action: 'configs.create',
    targetType: 'configFamily',
    targetId: family,
    metadata: { version: 1, mountPath, bytes: Buffer.byteLength(input.content, 'utf8') },
  });
  return { family, version: 1, name, mountPath };
}

/**
 * Edit = create v(n+1). Consumers keep running the version they mount until
 * `applyConfigVersion` redeploys them — the UI diffs old/new before this.
 */
export async function newConfigVersion(
  ctx: OrgContext,
  input: NewConfigVersionInput,
): Promise<NewConfigVersionResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const previousVersion = group.versions[0]!.version;
  const version = nextConfigVersion(group.versions.map((v) => v.version));
  const name = physicalConfigName(family, version);

  await createPhysical(
    ctx,
    node.id,
    name,
    input.content,
    managedLabels(ctx, family, version, group.mountPath),
  );
  await writeAudit(ctx, {
    action: 'configs.newVersion',
    targetType: 'configFamily',
    targetId: family,
    metadata: { version, previousVersion, bytes: Buffer.byteLength(input.content, 'utf8') },
  });
  return { family, version, name, previousVersion };
}

/**
 * Apply: redeploy every consumer onto `version` (the stable mount path is
 * unchanged, only the bytes swap). Applying an older version IS the rollback.
 */
export async function applyConfigVersion(
  ctx: OrgContext,
  input: ApplyConfigVersionInput,
): Promise<ApplyConfigResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const target = group.versions.find((v) => v.version === input.version);
  if (!target) throw notFound('config version', `${family} v${input.version}`);
  const rollback = target.version < group.versions[0]!.version;

  const mountPaths = mountPathsOf(families);
  const consumers = consumersOf(liveOrgServices(ctx), group);
  const redeployed: string[] = [];
  const skipped: string[] = [];
  for (const { service, version } of consumers) {
    if (version === target.version) {
      skipped.push(service.name);
      continue;
    }
    await redeployConsumer(ctx, node.id, service, group, target.name, mountPaths);
    redeployed.push(service.name);
  }

  await writeAudit(ctx, {
    action: 'configs.apply',
    targetType: 'configFamily',
    targetId: family,
    metadata: { version: target.version, rollback, redeployed, skipped },
  });
  return {
    family,
    version: target.version,
    redeployed: redeployed.sort(),
    skipped: skipped.sort(),
    rollback,
  };
}

/** Attach the family's CURRENT version to a service at the stable mount path. */
export async function attachConfigToService(
  ctx: OrgContext,
  input: AttachConfigInput,
): Promise<AttachConfigResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const current = group.versions[0]!;
  const app = findApp(ctx, input.service);

  const oldNames = new Set(group.versions.map((v) => v.name));
  const names = (app.configs ?? []).filter((n) => !oldNames.has(n));
  names.push(current.name);

  await deploy(ctx, node.id, rebuildSpec(app, names, mountPathsOf(families)));
  await writeAudit(ctx, {
    action: 'configs.attach',
    targetType: 'configFamily',
    targetId: family,
    metadata: { service: app.name, version: current.version, mountPath: group.mountPath },
  });
  return { family, service: app.name, version: current.version, mountPath: group.mountPath };
}

/** Detach: drop the family's refs from a service and redeploy it. */
export async function detachConfigFromService(
  ctx: OrgContext,
  input: DetachConfigInput,
): Promise<DetachConfigResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const app = findApp(ctx, input.service);

  const oldNames = new Set(group.versions.map((v) => v.name));
  if (!(app.configs ?? []).some((n) => oldNames.has(n))) {
    throw commandRejected(`service "${app.name}" does not use config "${family}"`);
  }
  const names = (app.configs ?? []).filter((n) => !oldNames.has(n));

  await deploy(ctx, node.id, rebuildSpec(app, names, mountPathsOf(families)));
  await writeAudit(ctx, {
    action: 'configs.detach',
    targetType: 'configFamily',
    targetId: family,
    metadata: { service: app.name },
  });
  return { family, service: app.name, detached: true };
}

/** Delete a whole family — refused while ANY service still consumes it. */
export async function deleteConfigFamily(
  ctx: OrgContext,
  input: { family: string },
): Promise<DeleteConfigFamilyResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const consumers = consumersOf(liveOrgServices(ctx), group);
  if (consumers.length > 0) {
    throw commandRejected(
      `config "${family}" is used by ${consumers.length} service(s): ${consumers
        .map((c) => c.service.name)
        .join(', ')} — detach them first`,
    );
  }
  const removedVersions: number[] = [];
  try {
    for (const v of group.versions) {
      await ctx.hub.dispatch(
        node.id,
        'config.remove',
        { name: v.name },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
      removedVersions.push(v.version);
    }
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'configs.delete',
    targetType: 'configFamily',
    targetId: family,
    metadata: { removedVersions },
  });
  return { family, removedVersions: removedVersions.sort((a, b) => a - b) };
}

/** Remove old versions no service references anymore (current always kept). */
export async function pruneConfigVersions(
  ctx: OrgContext,
  input: { family: string },
): Promise<PruneConfigVersionsResult> {
  const family = input.family.trim();
  const node = await resolveManagerNode(ctx);
  const { families } = await requireFamily(ctx, node.id);
  const group = findFamily(families, family);
  const current = group.versions[0]!;
  const inUse = new Set<string>();
  for (const s of liveOrgServices(ctx)) for (const n of s.configs ?? []) inUse.add(n);

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
        'config.remove',
        { name: v.name },
        { timeoutMs: DISPATCH_TIMEOUT_MS },
      );
      removedVersions.push(v.version);
    } catch (e) {
      throw mapDispatchError(e);
    }
  }
  await writeAudit(ctx, {
    action: 'configs.pruneVersions',
    targetType: 'configFamily',
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
