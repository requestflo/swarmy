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
import { BUILDER_ENABLE_HINT, UNGROUPED, isBuilderCapable, type BuildOverride } from '@swarmy/core';
import type { LogLine } from '@swarmy/core/views';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { TRPCError } from '@trpc/server';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { enforceAdmission } from './admission-gate';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';
import { fireEvent } from './alerts-fire';
import { buildLogBus } from './build-log-bus';
import { liveService } from './service.service';
import { promoteSpecFrom } from './releases.service';
import { DEFAULT_REGISTRY_HOST, canonicalRegistryHost, isOrgRegistryImage, onImageBuilt } from './registryPolicy.service'; // D3 hook

export type GitProvider = 'github' | 'gitlab';

import {
  REGISTRY_AUTH_USERNAME,
  REGISTRY_HTPASSWD_SECRET_PREFIX,
  REGISTRY_SERVICE_NAME,
  decodeRegistryCreds,
  generateRegistryCreds,
  htpasswdSecretName,
  registryAuthConverged,
  registryServiceSpec,
  renderHtpasswd,
  type RegistryCreds,
} from './registry-auth';

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
  /** Login username (never the password). `swarmy` = the auto-generated login. */
  username: string | null;
  /** 'auto-generated' (swarmy minted it), 'custom' (operator-supplied), or null (no login). */
  login: 'auto-generated' | 'custom' | null;
  /** The LIVE registry service enforces htpasswd auth with the stored login. */
  authEnforced: boolean;
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
  // Close an open (pre-auth) registry before pushing to it — best-effort.
  await convergeRegistryAuth(ctx).catch(() => undefined);
  const reg = await ensureRegistryConfig(ctx);
  const host = canonicalRegistryHost(reg.host);
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

  const credsEnc = decodeRegistryCreds(reg.credentialsEnc);

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
        // resolveBuilderNode only returns builder-capable nodes — assert it so
        // the agent's gate (buildGateAllows) lets the build through.
        builderCapable: true,
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
    // A green build clears the repo's open build-failed alert (default rule).
    void fireEvent(ctx, {
      signal: 'build-failed',
      severity: 'info',
      resource: `repo:${imageName}`,
      message: `Build of ${imageName}@${ref} succeeded`,
      status: 'resolved',
    }).catch(() => undefined);

    // D3 hook: registry policy on build success — trivy CVE scan + cosign sign
    // of the freshly pushed image, on the node that built it. Fire-and-forget:
    // policy work never delays or fails the build itself.
    void onImageBuilt(ctx, {
      imageRef,
      digest: result?.digest ?? null,
      nodeId: node.id,
    }).catch(() => undefined);

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
    // Default `build-failed` alert: event-style, so every failed build notifies.
    const tail = buildLogBus
      .snapshot(commandId)
      .lines.slice(-5)
      .map((l) => l.message)
      .join('\n');
    void fireEvent(ctx, {
      signal: 'build-failed',
      severity: 'warning',
      resource: `repo:${imageName}`,
      message: `Build of ${imageName}@${ref} failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}${tail ? `\n${tail}` : ''}`,
    }).catch(() => undefined);
    throw buildFailureError(e, buildLogBus.snapshot(commandId).lines);
  }
}

/** How many trailing build-log lines a failed build's error carries. */
const BUILD_ERROR_TAIL_LINES = 15;

/**
 * Map a failed build dispatch to a TRPCError whose message carries the last
 * few build-log lines, so the toast says WHY (not just "build exited 1").
 * An agent-side build failure (`build …`) is already self-describing (the agent
 * appends its own output tail) and must not be re-classified by
 * `mapDispatchError`'s keyword sniffing (a log line mentioning "timeout").
 */
export function buildFailureError(e: unknown, lines: Array<{ message: string }>): TRPCError {
  const message = e instanceof Error ? e.message : String(e);
  if (/^build (exited|finished)/.test(message)) {
    return commandRejected(message);
  }
  const mapped = mapDispatchError(e);
  const tail = lines
    .flatMap((l) => l.message.split(/\r?\n/))
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-BUILD_ERROR_TAIL_LINES);
  if (tail.length === 0) return mapped;
  // Keep the code + `cause.swarmyCode` the errorFormatter surfaces.
  return new TRPCError({ code: mapped.code, message: `${mapped.message}\n${tail.join('\n')}`, cause: mapped.cause });
}

/**
 * Autodeploy: update a service's image to the freshly-built digest and redeploy
 * via the existing `service.deploy` dispatch. Pins the service to the digest (not
 * a floating tag) so GC's "in prod" reasoning and rollback stay correct.
 */
export async function autodeployBuilt(ctx: OrgContext, serviceId: string, image: string): Promise<void> {
  // `serviceId` is the linked Docker service id (or name) — resolve it from live
  // inventory rather than a DB row. Docker is the source of truth for placement
  // and replica count; the redeploy pins the freshly-built digest.
  const service = liveService(ctx, serviceId);
  if (!service) return;
  const spec = { name: service.name, image, mode: { replicated: { replicas: service.replicas.desired } } };
  // Autodeploy is an unattended service deploy: it runs the same admission
  // spine, and a `block` violation skips the redeploy (nobody is there to
  // override). The build itself still succeeds; the refusal is audited.
  try {
    await enforceAdmission(
      ctx,
      {
        kind: 'service.deploy',
        orgId: ctx.activeOrgId,
        stackName: service.stack === UNGROUPED ? undefined : service.stack,
        specs: [{ ...spec, labels: service.labels }],
      },
      { targetType: 'service', targetId: service.id, mode: 'automation' },
    );
  } catch (e) {
    await writeAudit(ctx, {
      action: 'cicd.autodeploy.blocked',
      targetType: 'service',
      targetId: service.id,
      actorType: ctx.user ? 'user' : 'system',
      metadata: { image, reason: e instanceof Error ? e.message : String(e) },
    });
    return;
  }
  // Rebuild the full spec from the live inspect and swap only the image: a bare
  // `{name, image, replicas}` deploy would strip the service's env, ports,
  // mounts, networks, secrets and labels.
  const node = await resolveManagerNode(ctx);
  try {
    const raw = await ctx.hub.dispatch<{ inspect?: unknown }>(node.id, 'service.inspect', {
      service: service.name,
    });
    const full = promoteSpecFrom(raw?.inspect, image, service.networks.map((n) => n.name));
    if (!full) throw new Error(`could not read the live spec of "${service.name}"`);
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec: full, pullPolicy: 'always' });
  } catch (e) {
    await writeAudit(ctx, {
      action: 'cicd.autodeploy.failed',
      targetType: 'service',
      targetId: service.id,
      actorType: ctx.user ? 'user' : 'system',
      metadata: { image, reason: e instanceof Error ? e.message : String(e) },
    });
    return;
  }
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
  const creds = decodeRegistryCreds(row.credentialsEnc);
  const live = liveRegistryService(ctx);
  return {
    enabled: row.enabled,
    host: canonicalRegistryHost(row.host),
    hasCreds: Boolean(creds),
    username: creds?.username ?? null,
    login: creds ? (creds.username === REGISTRY_AUTH_USERNAME ? 'auto-generated' : 'custom') : null,
    authEnforced: Boolean(creds && live && registryAuthConverged(live, htpasswdSecretName(creds))),
    online: row.enabled && (await registryNodeOnline(ctx)),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Enable/disable the in-swarm registry. Enabling deploys a single-replica
 * `registry:2` swarm service on the `swarmy` overlay via the existing
 * `service.deploy` command path (it's just a swarm service swarmy manages),
 * with htpasswd auth ENFORCED: a login is auto-generated on first enable (or an
 * operator-supplied one is used) and stored encrypted; every push/pull swarmy
 * makes carries it automatically.
 */
export async function setRegistryEnabled(
  ctx: OrgContext,
  input: { enabled: boolean; username?: string; password?: string },
): Promise<RegistryConfigView> {
  const row = await ensureRegistryConfig(ctx);
  // Persisting the canonical host also migrates a legacy `swarmy-registry:5000` row.
  const host = canonicalRegistryHost(row.host);
  const supplied = input.username && input.password ? { username: input.username, password: input.password } : null;
  const existing = decodeRegistryCreds(row.credentialsEnc);
  // Enabling never leaves the registry open: reuse the stored login, else mint one.
  const creds = supplied ?? existing ?? (input.enabled ? generateRegistryCreds() : null);
  const credsChanged = Boolean(creds) && (creds?.username !== existing?.username || creds?.password !== existing?.password);
  const credentialsEnc = creds && credsChanged ? encryptSecret(JSON.stringify(creds)) : row.credentialsEnc;

  await ctx.db.registryConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { enabled: input.enabled, host, credentialsEnc },
  });

  if (input.enabled && creds) {
    await deployAuthedRegistry(ctx, creds).catch(() => undefined);
    // A new login invalidates the pull creds services already carry (and
    // services deployed while the registry was open carry none).
    if (credsChanged) void reauthOrgRegistryServices(ctx, host).catch(() => undefined);
  } else if (!input.enabled) {
    const node = await resolveManagerNode(ctx).catch(() => null);
    if (node) await ctx.hub.dispatch(node.id, 'service.remove', { service: REGISTRY_SERVICE_NAME }).catch(() => undefined);
  }

  await writeAudit(ctx, {
    action: input.enabled ? 'cicd.registry.enable' : 'cicd.registry.disable',
    targetType: 'registryConfig',
    targetId: ctx.activeOrgId,
    metadata: { login: supplied ? 'custom' : creds ? 'auto-generated' : 'none', credsChanged },
  });
  return getRegistryConfig(ctx);
}

/**
 * Rotate the registry login: mint a new password, re-render the htpasswd secret
 * (new content-addressed name), update the registry, then re-stamp the pull
 * creds on every live service that pulls from it (a rolling update, exactly
 * like `docker service update --with-registry-auth`).
 */
export async function rotateRegistryCredentials(ctx: OrgContext): Promise<RegistryConfigView> {
  const row = await ensureRegistryConfig(ctx);
  if (!row.enabled) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Enable the registry first.' });
  const creds = generateRegistryCreds();
  await ctx.db.registryConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: { credentialsEnc: encryptSecret(JSON.stringify(creds)) },
  });
  await deployAuthedRegistry(ctx, creds);
  const host = canonicalRegistryHost(row.host);
  const reauthed = await reauthOrgRegistryServices(ctx, host).catch(() => 0);
  await writeAudit(ctx, {
    action: 'cicd.registry.rotate',
    targetType: 'registryConfig',
    targetId: ctx.activeOrgId,
    metadata: { reauthedServices: reauthed },
  });
  return getRegistryConfig(ctx);
}

/**
 * Converge an ENABLED registry onto enforced auth: mints + stores a login when
 * none exists (a pre-auth install), and redeploys the registry when the live
 * service is not running htpasswd auth with the stored login's secret. Reads
 * the live service from the hub (Docker truth); a registry the hub cannot see
 * (not deployed / hub warming up) is left alone. Called before builds and by
 * the image-gc worker tick.
 */
export async function convergeRegistryAuth(ctx: OrgContext): Promise<'noop' | 'converged' | 'skipped'> {
  const row = await ensureRegistryConfig(ctx);
  if (!row.enabled) return 'skipped';
  const live = liveRegistryService(ctx);
  if (!live) return 'skipped';
  const existing = decodeRegistryCreds(row.credentialsEnc);
  if (existing && registryAuthConverged(live, htpasswdSecretName(existing))) return 'noop';
  const creds = existing ?? generateRegistryCreds();
  if (!existing) {
    await ctx.db.registryConfig.update({
      where: { orgId: ctx.activeOrgId },
      data: { credentialsEnc: encryptSecret(JSON.stringify(creds)) },
    });
  }
  await deployAuthedRegistry(ctx, creds);
  // Services deployed while the registry was open carry no pull creds.
  const reauthed = await reauthOrgRegistryServices(ctx, canonicalRegistryHost(row.host)).catch(() => 0);
  await writeAudit(ctx, {
    action: 'cicd.registry.authConverge',
    targetType: 'registryConfig',
    targetId: ctx.activeOrgId,
    actorType: ctx.user ? 'user' : 'system',
    metadata: { minted: !existing, reauthedServices: reauthed },
  });
  return 'converged';
}

/**
 * Deliver the htpasswd as a content-addressed Docker secret, deploy the
 * registry with auth enforced, then best-effort remove superseded htpasswd
 * secrets (no longer referenced once the service spec moved on).
 */
async function deployAuthedRegistry(ctx: OrgContext, creds: RegistryCreds): Promise<void> {
  const node = await resolveManagerNode(ctx);
  const secretName = htpasswdSecretName(creds);
  const dataB64 = Buffer.from(await renderHtpasswd(creds), 'utf8').toString('base64');
  try {
    await ctx.hub.dispatch(node.id, 'secret.create', {
      name: secretName,
      dataB64,
      labels: { 'swarmy.managed': 'true', 'swarmy.registry.htpasswd': 'true' },
    });
  } catch (e) {
    // Same name ⇒ same login (content-addressed): an existing secret is fine.
    if (!/already exists|conflict/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  await ctx.hub.dispatch(node.id, 'service.deploy', { spec: registryServiceSpec(secretName), pullPolicy: 'missing' });
  try {
    const listed = await ctx.hub.dispatch<{ secrets?: Array<{ name: string }> }>(node.id, 'secret.list', {});
    for (const s of listed?.secrets ?? []) {
      if (s.name.startsWith(REGISTRY_HTPASSWD_SECRET_PREFIX) && s.name !== secretName) {
        await ctx.hub.dispatch(node.id, 'secret.remove', { name: s.name }).catch(() => undefined);
      }
    }
  } catch {
    // Stale secrets are harmless (the registry no longer mounts them).
  }
}

/**
 * Re-stamp pull creds on every live service pulling from the org registry: a
 * full-spec redeploy (rebuilt from the live inspect, image unchanged) through
 * `service.deploy`, which the hub decorator decorates with the CURRENT login.
 * Returns how many services were updated.
 */
async function reauthOrgRegistryServices(ctx: OrgContext, host: string): Promise<number> {
  const node = await resolveManagerNode(ctx);
  let n = 0;
  for (const svc of ctx.hub.liveInventory(ctx.activeOrgId).services) {
    if (svc.name === REGISTRY_SERVICE_NAME || !isOrgRegistryImage(svc.image, host)) continue;
    try {
      const raw = await ctx.hub.dispatch<{ inspect?: unknown }>(node.id, 'service.inspect', { service: svc.name });
      const spec = promoteSpecFrom(raw?.inspect, svc.image, svc.networks.map((x) => x.name));
      if (!spec) continue;
      await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'missing' });
      n++;
    } catch {
      // Best-effort per service; the next converge/rotation retries.
    }
  }
  return n;
}

function liveRegistryService(ctx: OrgContext) {
  return ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === REGISTRY_SERVICE_NAME);
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
    create: { orgId: ctx.activeOrgId, enabled: false, host: DEFAULT_REGISTRY_HOST },
    update: {},
  });
}

async function registryNodeOnline(ctx: OrgContext): Promise<boolean> {
  return resolveManagerNode(ctx)
    .then((n) => ctx.hub.isOnline(n.id))
    .catch(() => false);
}

/** One candidate for `pickBuilderNode` (live labels + the agent's reported override). */
export interface BuilderCandidate {
  id: string;
  name?: string;
  labels: Record<string, string> | undefined;
  buildOverride: BuildOverride | undefined;
  online: boolean;
}

/**
 * Pure builder choice: an ONLINE builder-capable node (Builder role label, or
 * the agent's explicit SWARMY_ALLOW_BUILD=true; a local `false` vetoes). Never
 * falls back to a non-builder node — that agent would only answer
 * E_BUILD_DISABLED. Returns an actionable reason when nothing qualifies.
 */
export function pickBuilderNode(
  candidates: BuilderCandidate[],
): { ok: true; id: string } | { ok: false; reason: string } {
  const capable = candidates.filter((c) => isBuilderCapable(c.labels, c.buildOverride));
  const online = capable.find((c) => c.online);
  if (online) return { ok: true, id: online.id };
  if (capable.length > 0) {
    const names = capable.map((c) => c.name ?? c.id).join(', ');
    return {
      ok: false,
      reason: `No builder node is online (Builder role: ${names}). Bring one back online, or ${BUILDER_ENABLE_HINT}.`,
    };
  }
  return { ok: false, reason: `No node can run builds yet — ${BUILDER_ENABLE_HINT}.` };
}

/** Resolve the org's builder node (live Docker labels + agent facts), or fail with how to enable one. */
async function resolveBuilderNode(ctx: OrgContext): Promise<{ id: string }> {
  // Membership/identity comes from the DB (enrollment node id); the builder role
  // label is Docker truth, read live from the hub via the hostname bridge.
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true, name: true },
  });
  const pick = pickBuilderNode(
    nodes.map((n) => ({
      id: n.id,
      name: n.name,
      labels: ctx.hub.nodeInfoFor(n.id)?.labels,
      buildOverride: ctx.hub.agentBuildFor?.(n.id)?.buildOverride,
      online: ctx.hub.isOnline(n.id),
    })),
  );
  if (!pick.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: pick.reason });
  return { id: pick.id };
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
