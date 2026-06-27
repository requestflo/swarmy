/**
 * Git CI/CD + in-swarm registry service (epic: git-cicd-registry, MVP).
 *
 * Closes the loop: link a git repo → build an image on a builder-labeled node via
 * the `image.build` agent command → push to an in-swarm `registry:2` swarm
 * service (deployed via the existing `service.deploy` path) → record a `Build`
 * whose digest bridges into the deployments pipeline. Image GC policy (kept
 * conservative) is stored per-org.
 *
 * Everything is org-scoped and audited. Secrets (git/registry tokens) are
 * encrypted at rest with the shared credential vault and resolved JIT at dispatch
 * — never returned to the client, never persisted in the build record.
 *
 * NOTE: this service references Prisma models added in INTEGRATION (`GitRepo`,
 * `Build`, `RegistryConfig`, `ImageGcPolicy`). Until `bun db:generate` runs, the
 * `ctx.db.gitRepo` etc. accessors will not typecheck.
 */
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';

export type GitProvider = 'github' | 'gitlab';

const REGISTRY_SERVICE_NAME = 'swarmy-registry';
const REGISTRY_IMAGE = 'registry:2';
const REGISTRY_PORT = 5000;

// ── Views (secrets never included) ──────────────────────────────────────────

export interface GitRepoView {
  id: string;
  provider: GitProvider;
  url: string;
  branch: string;
  autodeploy: boolean;
  serviceId: string | null;
  hasToken: boolean;
  createdAt: string;
}

export interface BuildView {
  id: string;
  repoId: string;
  repoUrl: string;
  commit: string | null;
  status: string;
  image: string | null;
  logsRef: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RegistryConfigView {
  enabled: boolean;
  host: string | null;
  hasCreds: boolean;
  online: boolean;
  updatedAt: string;
}

export interface GcPolicyView {
  mode: 'on-healthcheck' | 'age-days';
  keepProd: boolean;
  days: number | null;
}

// ── Git repos ────────────────────────────────────────────────────────────────

export async function listRepos(ctx: OrgContext): Promise<GitRepoView[]> {
  const rows = await ctx.db.gitRepo.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRepoView);
}

export async function addRepo(
  ctx: OrgContext,
  input: {
    provider: GitProvider;
    url: string;
    branch?: string;
    token?: string;
    autodeploy?: boolean;
    serviceId?: string | null;
  },
): Promise<GitRepoView> {
  const row = await ctx.db.gitRepo.create({
    data: {
      orgId: ctx.activeOrgId,
      provider: input.provider === 'gitlab' ? 'GITLAB' : 'GITHUB',
      url: input.url,
      branch: input.branch ?? 'main',
      tokenEnc: input.token ? encryptSecret(input.token) : null,
      autodeploy: input.autodeploy ?? false,
      serviceId: input.serviceId ?? null,
    },
  });
  await writeAudit(ctx, {
    action: 'cicd.addRepo',
    targetType: 'gitRepo',
    targetId: row.id,
    metadata: { provider: input.provider, url: input.url },
  });
  return toRepoView(row);
}

export async function removeRepo(ctx: OrgContext, id: string): Promise<{ id: string; removed: true }> {
  const row = await ctx.db.gitRepo.findFirst({ where: { id, orgId: ctx.activeOrgId }, select: { id: true } });
  if (!row) throw notFound('repo', id);
  await ctx.db.gitRepo.delete({ where: { id } });
  await writeAudit(ctx, { action: 'cicd.removeRepo', targetType: 'gitRepo', targetId: id });
  return { id, removed: true };
}

// ── Builds ───────────────────────────────────────────────────────────────────

export async function listBuilds(ctx: OrgContext, repoId?: string): Promise<BuildView[]> {
  const rows = await ctx.db.build.findMany({
    where: { orgId: ctx.activeOrgId, ...(repoId ? { repoId } : {}) },
    include: { repo: { select: { url: true } } },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    repoId: r.repoId,
    repoUrl: r.repo?.url ?? '',
    commit: r.commit,
    status: r.status.toLowerCase(),
    image: r.image,
    logsRef: r.logsRef,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

/**
 * Trigger a build: resolve a builder node by label, dispatch `image.build` with
 * resolved secrets, and persist a `Build`. The dispatch is fire-and-await-result
 * (logs stream over the existing `logChunk` plumbing keyed by the commandId).
 */
export async function triggerBuild(
  ctx: OrgContext,
  input: { repoId: string; ref?: string },
): Promise<BuildView> {
  const repo = await ctx.db.gitRepo.findFirst({ where: { id: input.repoId, orgId: ctx.activeOrgId } });
  if (!repo) throw notFound('repo', input.repoId);

  const node = await resolveBuilderNode(ctx);
  const reg = await ensureRegistryConfig(ctx);
  const host = reg.host ?? `${REGISTRY_SERVICE_NAME}:${REGISTRY_PORT}`;
  const ref = input.ref ?? repo.branch;
  const commandId = randomUUID();
  const imageName = repoImageName(repo.url);
  const imageRef = `${host}/${imageName}:${ref.replace(/[^\w.-]/g, '-')}`;

  const build = await ctx.db.build.create({
    data: {
      orgId: ctx.activeOrgId,
      repoId: repo.id,
      commit: ref,
      status: 'BUILDING',
      image: imageRef,
      logsRef: commandId,
      startedAt: new Date(),
    },
  });

  await writeAudit(ctx, {
    action: 'cicd.triggerBuild',
    targetType: 'build',
    targetId: build.id,
    metadata: { repoId: repo.id, ref },
  });

  const credsEnc = reg.credentialsEnc ? (JSON.parse(decryptSecret(reg.credentialsEnc)) as {
    username: string;
    password: string;
  }) : null;

  try {
    const result = await ctx.hub.dispatch<{ digest: string; imageRefs: string[] }>(
      node.id,
      'image.build',
      {
        commandId,
        source: {
          url: repo.url,
          ref,
          token: repo.tokenEnc ? decryptSecret(repo.tokenEnc) : undefined,
        },
        imageRefs: [imageRef],
        pushPolicy: 'always',
        registryAuth: credsEnc
          ? { username: credsEnc.username, password: credsEnc.password, server: host }
          : undefined,
      },
    );
    const digested = result?.digest ? `${host}/${imageName}@${result.digest}` : imageRef;
    const finished = await ctx.db.build.update({
      where: { id: build.id },
      data: { status: 'SUCCEEDED', image: digested, finishedAt: new Date() },
      include: { repo: { select: { url: true } } },
    });

    if (repo.autodeploy && repo.serviceId) {
      await deployBuilt(ctx, repo.serviceId, digested);
    }

    return {
      id: finished.id,
      repoId: finished.repoId,
      repoUrl: finished.repo?.url ?? repo.url,
      commit: finished.commit,
      status: 'succeeded',
      image: finished.image,
      logsRef: finished.logsRef,
      startedAt: finished.startedAt?.toISOString() ?? null,
      finishedAt: finished.finishedAt?.toISOString() ?? null,
    };
  } catch (e) {
    await ctx.db.build.update({
      where: { id: build.id },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
    throw mapDispatchError(e);
  }
}

/** Update a service's image to the freshly-built digest and redeploy it. */
async function deployBuilt(ctx: OrgContext, serviceId: string, image: string): Promise<void> {
  const service = await ctx.db.service.findFirst({
    where: { id: serviceId, orgId: ctx.activeOrgId },
    select: { id: true, name: true, replicas: true },
  });
  if (!service) return;
  const node = await resolveManagerNode(ctx);
  await ctx.db.service.update({ where: { id: service.id }, data: { image, status: 'DEPLOYING' } });
  await ctx.hub
    .dispatch(node.id, 'service.deploy', {
      spec: { name: service.name, image, mode: { replicated: { replicas: service.replicas } } },
      pullPolicy: 'always',
    })
    .catch(() => undefined);
}

// ── Registry ─────────────────────────────────────────────────────────────────

export async function getRegistryConfig(ctx: OrgContext): Promise<RegistryConfigView> {
  const row = await ensureRegistryConfig(ctx);
  return {
    enabled: row.enabled,
    host: row.host,
    hasCreds: Boolean(row.credentialsEnc),
    online: row.enabled && (await registryNodeOnline(ctx)),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Enable/disable the in-swarm registry. Enabling deploys a single-replica
 * `registry:2` swarm service on the `swarmy` overlay via the existing
 * `service.deploy` command path (it's just a swarm service swarmy manages).
 */
export async function setRegistryEnabled(
  ctx: OrgContext,
  input: { enabled: boolean; username?: string; password?: string },
): Promise<RegistryConfigView> {
  const row = await ensureRegistryConfig(ctx);
  const host = row.host ?? `${REGISTRY_SERVICE_NAME}:${REGISTRY_PORT}`;
  const credentialsEnc =
    input.username && input.password
      ? encryptSecret(JSON.stringify({ username: input.username, password: input.password }))
      : row.credentialsEnc;

  await ctx.db.registryConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { enabled: input.enabled, host, credentialsEnc },
  });

  if (input.enabled) {
    const node = await resolveManagerNode(ctx);
    await ctx.hub
      .dispatch(node.id, 'service.deploy', {
        spec: {
          name: REGISTRY_SERVICE_NAME,
          image: REGISTRY_IMAGE,
          mode: { replicated: { replicas: 1 } },
          ports: [{ target: REGISTRY_PORT, published: REGISTRY_PORT, protocol: 'tcp', mode: 'ingress' }],
          networks: ['swarmy'],
          mounts: [{ type: 'volume', source: 'swarmy-registry-data', target: '/var/lib/registry' }],
        },
        pullPolicy: 'missing',
      })
      .catch(() => undefined);
  } else {
    const node = await resolveManagerNode(ctx).catch(() => null);
    if (node) await ctx.hub.dispatch(node.id, 'service.remove', { service: REGISTRY_SERVICE_NAME }).catch(() => undefined);
  }

  await writeAudit(ctx, {
    action: input.enabled ? 'cicd.registry.enable' : 'cicd.registry.disable',
    targetType: 'registryConfig',
    targetId: ctx.activeOrgId,
  });
  return getRegistryConfig(ctx);
}

// ── GC policy ────────────────────────────────────────────────────────────────

export async function getGcPolicy(ctx: OrgContext): Promise<GcPolicyView> {
  const row = await ctx.db.imageGcPolicy.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId },
    update: {},
  });
  return {
    mode: row.mode === 'AGE_DAYS' ? 'age-days' : 'on-healthcheck',
    keepProd: row.keepProd,
    days: row.days,
  };
}

export async function setGcPolicy(ctx: OrgContext, input: GcPolicyView): Promise<GcPolicyView> {
  await ctx.db.imageGcPolicy.upsert({
    where: { orgId: ctx.activeOrgId },
    create: {
      orgId: ctx.activeOrgId,
      mode: input.mode === 'age-days' ? 'AGE_DAYS' : 'ON_HEALTHCHECK',
      keepProd: input.keepProd,
      days: input.days,
    },
    update: {
      mode: input.mode === 'age-days' ? 'AGE_DAYS' : 'ON_HEALTHCHECK',
      keepProd: input.keepProd,
      days: input.days,
    },
  });
  await writeAudit(ctx, { action: 'cicd.gc.set', targetType: 'imageGcPolicy', targetId: ctx.activeOrgId, metadata: { ...input } });
  return getGcPolicy(ctx);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RegistryRow {
  enabled: boolean;
  host: string | null;
  credentialsEnc: string | null;
  updatedAt: Date;
}

async function ensureRegistryConfig(ctx: OrgContext): Promise<RegistryRow> {
  return ctx.db.registryConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, enabled: false, host: `${REGISTRY_SERVICE_NAME}:${REGISTRY_PORT}` },
    update: {},
  });
}

async function registryNodeOnline(ctx: OrgContext): Promise<boolean> {
  return resolveManagerNode(ctx)
    .then((n) => ctx.hub.isOnline(n.id))
    .catch(() => false);
}

/** Pick an online builder node (label `swarmy.role=builder`), else any online node. */
async function resolveBuilderNode(ctx: OrgContext): Promise<{ id: string }> {
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, labels: true },
  });
  const builders = nodes.filter((n) => {
    const labels = (n.labels as Record<string, string> | null) ?? {};
    return labels['swarmy.role'] === 'builder';
  });
  const onlineBuilder = builders.find((n) => ctx.hub.isOnline(n.id));
  if (onlineBuilder) return { id: onlineBuilder.id };
  const anyOnline = nodes.find((n) => ctx.hub.isOnline(n.id));
  if (anyOnline) return { id: anyOnline.id };
  return resolveManagerNode(ctx);
}

function toRepoView(r: {
  id: string;
  provider: string;
  url: string;
  branch: string;
  autodeploy: boolean;
  serviceId: string | null;
  tokenEnc: string | null;
  createdAt: Date;
}): GitRepoView {
  return {
    id: r.id,
    provider: r.provider === 'GITLAB' ? 'gitlab' : 'github',
    url: r.url,
    branch: r.branch,
    autodeploy: r.autodeploy,
    serviceId: r.serviceId,
    hasToken: Boolean(r.tokenEnc),
    createdAt: r.createdAt.toISOString(),
  };
}

/** Derive a registry image name from a repo URL (`owner/repo` → `owner-repo`). */
function repoImageName(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '');
  return cleaned.toLowerCase().replace(/[^a-z0-9._/-]/g, '-') || 'app';
}
