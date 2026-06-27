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
import { decryptSecret, encryptSecret, randomToken } from '@swarmy/core/crypto';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { LogLine } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';
import { buildLogBus } from './build-log-bus';

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
  // Mint a per-repo webhook secret up front so the provider receiver can verify
  // the HMAC immediately; surfaced (decrypted) once via `getWebhookInfo`.
  const webhookSecret = randomToken('whsec');
  const row = await ctx.db.gitRepo.create({
    data: {
      orgId: ctx.activeOrgId,
      provider: input.provider === 'gitlab' ? 'GITLAB' : 'GITHUB',
      url: input.url,
      branch: input.branch ?? 'main',
      tokenEnc: input.token ? encryptSecret(input.token) : null,
      webhookSecretEnc: encryptSecret(webhookSecret),
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

/**
 * Webhook URL + secret to paste into the provider. The secret is returned in
 * plaintext (decrypted from the vault) — this is the one place it leaves the
 * controller, so the operator can configure GitHub/GitLab.
 */
export async function getWebhookInfo(
  ctx: OrgContext,
  repoId: string,
  publicUrl: string,
): Promise<{ url: string; secret: string; provider: GitProvider }> {
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: repoId, orgId: ctx.activeOrgId },
    select: { id: true, provider: true, webhookSecretEnc: true },
  });
  if (!repo) throw notFound('repo', repoId);
  const base = publicUrl.replace(/\/+$/, '');
  return {
    url: `${base}/webhooks/git/${repo.id}`,
    secret: repo.webhookSecretEnc ? decryptSecret(repo.webhookSecretEnc) : '',
    provider: repo.provider === 'GITLAB' ? 'gitlab' : 'github',
  };
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
 * Trigger a build (dashboard / API-key principal): resolve a builder node by
 * label, dispatch `image.build` with resolved secrets, and persist a `Build`.
 * Logs stream over the existing `logChunk` plumbing keyed by the commandId
 * (== `Build.logsRef`), surfaced live by the build-log viewer.
 */
export async function triggerBuild(
  ctx: OrgContext,
  input: { repoId: string; ref?: string },
): Promise<BuildView> {
  const repo = await ctx.db.gitRepo.findFirst({ where: { id: input.repoId, orgId: ctx.activeOrgId } });
  if (!repo) throw notFound('repo', input.repoId);
  await writeAudit(ctx, {
    action: 'cicd.triggerBuild',
    targetType: 'gitRepo',
    targetId: repo.id,
    metadata: { ref: input.ref ?? repo.branch },
  });
  return runBuild(ctx, repo, { ref: input.ref });
}

/**
 * Trigger a build for a repo from OUTSIDE a session (git webhook / poll). Builds
 * a SYSTEM `OrgContext` for the repo's org so the exact same `runBuild` path —
 * dispatch, persistence, audit, autodeploy — runs identically to a UI build,
 * audited as `actorType: system`.
 */
export async function triggerBuildForRepo(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  input: { repoId: string; orgId: string; ref?: string; commit?: string | null },
): Promise<BuildView> {
  const repo = await deps.db.gitRepo.findFirst({ where: { id: input.repoId, orgId: input.orgId } });
  if (!repo) throw notFound('repo', input.repoId);
  const ctx = systemContext(deps, input.orgId);
  return runBuild(ctx, repo, { ref: input.ref, commit: input.commit ?? undefined, triggeredBy: 'system' });
}

interface RepoRow {
  id: string;
  url: string;
  branch: string;
  provider: string;
  tokenEnc: string | null;
  autodeploy: boolean;
  serviceId: string | null;
}

/** Shared build core used by both the UI trigger and the webhook/poll trigger. */
async function runBuild(
  ctx: OrgContext,
  repo: RepoRow,
  opts: { ref?: string; commit?: string; triggeredBy?: 'user' | 'system' },
): Promise<BuildView> {
  const node = await resolveBuilderNode(ctx);
  const reg = await ensureRegistryConfig(ctx);
  const host = reg.host ?? `${REGISTRY_SERVICE_NAME}:${REGISTRY_PORT}`;
  const ref = opts.ref ?? repo.branch;
  const commandId = randomUUID();
  const imageName = repoImageName(repo.url);
  const imageRef = `${host}/${imageName}:${ref.replace(/[^\w.-]/g, '-')}`;

  const build = await ctx.db.build.create({
    data: {
      orgId: ctx.activeOrgId,
      repoId: repo.id,
      commit: opts.commit ?? ref,
      status: 'BUILDING',
      image: imageRef,
      logsRef: commandId,
      startedAt: new Date(),
    },
  });

  const credsEnc = reg.credentialsEnc
    ? (JSON.parse(decryptSecret(reg.credentialsEnc)) as { username: string; password: string })
    : null;

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
      { timeoutMs: 1_800_000 },
    );
    buildLogBus.finish(commandId);
    const digested = result?.digest ? `${host}/${imageName}@${result.digest}` : imageRef;
    const finished = await ctx.db.build.update({
      where: { id: build.id },
      data: { status: 'SUCCEEDED', image: digested, finishedAt: new Date() },
      include: { repo: { select: { url: true } } },
    });

    // Autodeploy: a SUCCEEDED build whose repo is linked to a service + opted in
    // redeploys that service to the freshly-built digest (reusing the deploy path).
    if (repo.autodeploy && repo.serviceId && result?.digest) {
      await autodeployBuilt(ctx, repo.serviceId, digested);
    }

    return toBuildView(finished, repo.url);
  } catch (e) {
    buildLogBus.finish(commandId);
    await ctx.db.build.update({
      where: { id: build.id },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
    throw mapDispatchError(e);
  }
}

/**
 * Autodeploy: update a service's image to the freshly-built digest and redeploy
 * via the existing `service.deploy` dispatch. Pins the service to the digest (not
 * a floating tag) so GC's "in prod" reasoning and rollback stay correct.
 */
export async function autodeployBuilt(ctx: OrgContext, serviceId: string, image: string): Promise<void> {
  const service = await ctx.db.service.findFirst({
    where: { id: serviceId, orgId: ctx.activeOrgId },
    select: { id: true, name: true, replicas: true },
  });
  if (!service) return;
  const node = await resolveManagerNode(ctx);
  await ctx.db.service.update({ where: { id: service.id }, data: { image, status: 'DEPLOYING' } });
  await ctx.db.deployment.create({
    data: {
      orgId: ctx.activeOrgId,
      targetType: 'SERVICE',
      serviceId: service.id,
      kind: 'autodeploy',
      phase: 'COMPLETE',
      imageDigest: image,
    },
  });
  await ctx.hub
    .dispatch(node.id, 'service.deploy', {
      spec: { name: service.name, image, mode: { replicated: { replicas: service.replicas } } },
      pullPolicy: 'always',
    })
    .catch(() => undefined);
  await writeAudit(ctx, {
    action: 'cicd.autodeploy',
    targetType: 'service',
    targetId: service.id,
    metadata: { image },
  });
}

function toBuildView(
  r: {
    id: string;
    repoId: string;
    commit: string | null;
    status: string;
    image: string | null;
    logsRef: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    repo?: { url: string } | null;
  },
  fallbackUrl: string,
): BuildView {
  return {
    id: r.id,
    repoId: r.repoId,
    repoUrl: r.repo?.url ?? fallbackUrl,
    commit: r.commit,
    status: r.status.toLowerCase(),
    image: r.image,
    logsRef: r.logsRef,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
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

// ── Build logs (live viewer) ──────────────────────────────────────────────────

export interface BuildLogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

/** Historical scrollback for a build (from the in-memory bus). Org-scoped. */
export async function getBuildLogPage(
  ctx: OrgContext,
  buildId: string,
): Promise<{ lines: BuildLogLine[]; done: boolean; status: string }> {
  const build = await ctx.db.build.findFirst({
    where: { id: buildId, orgId: ctx.activeOrgId },
    select: { logsRef: true, status: true, finishedAt: true },
  });
  if (!build) throw notFound('build', buildId);
  const snap = build.logsRef ? buildLogBus.snapshot(build.logsRef) : { lines: [], done: false };
  return {
    lines: snap.lines.map((l) => ({ seq: l.seq, stream: l.stream, message: l.message })),
    done: snap.done || Boolean(build.finishedAt),
    status: build.status.toLowerCase(),
  };
}

/**
 * Live build-log tail: replays current scrollback, then streams new lines until
 * the build finishes or the subscription aborts. Backed by the in-memory bus the
 * gateway bridge feeds from the existing `logChunk` plumbing.
 */
export async function* subscribeBuildLog(
  ctx: OrgContext,
  buildId: string,
  signal: AbortSignal,
): AsyncIterable<BuildLogLine> {
  const build = await ctx.db.build.findFirst({
    where: { id: buildId, orgId: ctx.activeOrgId },
    select: { logsRef: true, finishedAt: true },
  });
  if (!build?.logsRef) throw notFound('build', buildId);
  const ref = build.logsRef;

  const queue: LogLine[] = [];
  let wake: (() => void) | null = null;
  const off = buildLogBus.subscribe(ref, (line) => {
    queue.push(line);
    wake?.();
    wake = null;
  });
  // Replay existing scrollback first so a late viewer sees the whole build.
  for (const l of buildLogBus.snapshot(ref).lines) queue.push(l);

  const onAbort = () => {
    wake?.();
    wake = null;
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (!signal.aborted) {
      if (queue.length === 0) {
        if (buildLogBus.isDone(ref) || build.finishedAt) break;
        await new Promise<void>((r) => {
          wake = r;
        });
        if (signal.aborted) break;
      }
      while (queue.length) {
        const l = queue.shift() as LogLine;
        yield { seq: l.seq, stream: l.stream, message: l.message };
      }
    }
  } finally {
    off();
    signal.removeEventListener('abort', onAbort);
  }
}

// ── GC plan engine (pure, unit-tested) ────────────────────────────────────────

export interface GcCandidate {
  /** Build id (for audit) and its image digest (`repo@sha256:…` or `sha256:…`). */
  buildId: string;
  digest: string | null;
  finishedAt: Date | null;
}

export interface GcPlanInput {
  mode: 'on-healthcheck' | 'age-days';
  days: number | null;
  keepProd: boolean;
  /** Digests referenced by a service/deployment running in prod — never deleted. */
  pinnedDigests: Set<string>;
  candidates: GcCandidate[];
  now: Date;
}

export interface GcPlan {
  /** Digests selected for removal (already excludes the pinned set). */
  remove: string[];
  /** Digests kept because they are pinned in prod. */
  pinned: string[];
}

/** Bare `sha256:…` from a `repo@sha256:…` ref (or pass-through). */
export function bareDigest(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at >= 0 ? ref.slice(at + 1) : ref;
}

/**
 * Pure GC decision. The cardinal invariant (unit-tested): a digest in
 * `pinnedDigests` is NEVER in `remove`, regardless of mode/age — that is the
 * "never prune the in-prod digest" guarantee. With `keepProd: false` the pin set
 * is treated as empty (explicit opt-out for a hobby box).
 */
export function computeGcPlan(input: GcPlanInput): GcPlan {
  const pinned = input.keepProd ? new Set([...input.pinnedDigests].map(bareDigest)) : new Set<string>();
  const remove = new Set<string>();

  if (input.mode === 'age-days') {
    const cutoff = input.now.getTime() - (input.days ?? 0) * 24 * 60 * 60 * 1000;
    for (const c of input.candidates) {
      if (!c.digest) continue;
      const d = bareDigest(c.digest);
      if (pinned.has(d)) continue; // never prune in-prod, even if old
      const ts = c.finishedAt?.getTime() ?? 0;
      if (ts > 0 && ts < cutoff) remove.add(d);
    }
  } else {
    // on-healthcheck: prune every non-pinned candidate (the new image already
    // passed; older non-prod images are superseded).
    for (const c of input.candidates) {
      if (!c.digest) continue;
      const d = bareDigest(c.digest);
      if (pinned.has(d)) continue;
      remove.add(d);
    }
  }

  return { remove: [...remove], pinned: [...pinned] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RegistryRow {
  enabled: boolean;
  host: string | null;
  credentialsEnc: string | null;
  updatedAt: Date;
}

/**
 * Build a SYSTEM `OrgContext` for an org with no session — used by the webhook
 * receiver and the GC worker. Mirrors `resolveOrgContextFromApiKey`'s shape; the
 * synthetic principal is sufficient for the services layer (audit `actorType` is
 * derived from the absence of a real user → `system`).
 */
export function systemContext(deps: { db: DB; hub: AgentHub; auth: Auth }, orgId: string): OrgContext {
  return {
    db: deps.db,
    hub: deps.hub,
    auth: deps.auth,
    session: null,
    user: null,
    activeOrgId: orgId,
    reqHeaders: new Headers(),
    membership: { role: 'owner', orgId },
  } as unknown as OrgContext;
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
