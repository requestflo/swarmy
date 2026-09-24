/**
 * Git provider connections (git-apps Phase 2): the controller's own GitHub
 * App (manifest flow), org-bound installations, GitLab OAuth / token, generic
 * git (PAT or a swarmy deploy key), the repo + branch picker, JIT credentials
 * for clone/build, and `inspectCommit` (git.inspect over container.runOnce).
 *
 * Invariants (cicd-registry skill):
 *   - Every secret is vault-encrypted (`@swarmy/core/crypto`) and never
 *     returned to a client. GitHub installation tokens are minted per use and
 *     cached in memory only (≤ 55 min).
 *   - Org is the hard wall: an installation is bound to exactly one org, and
 *     only after the installing user's own OAuth token proves they can see it.
 *   - Everything that changes a connection is audited.
 */
import { createHmac } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { Auth } from '@swarmy/auth';
import { decryptSecret, encryptSecret, isVaultConfigured, randomToken } from '@swarmy/core/crypto';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import type { AgentHub } from '../hub/types';
import { writeAudit } from './audit.service';
import { resolveBuilderNode, systemContext } from './cicd.service';
import {
  connectionCredentials,
  controllerPublicUrl,
  gitFetch,
  repoCredentials,
  type GitCredentials,
} from './git-credentials';
import {
  buildGithubManifest,
  configPathsIn,
  convertManifest,
  createGitlabProjectHook,
  createInstallationToken,
  exchangeGitlabCode,
  exchangeOAuthCode,
  generateDeployKey,
  getInstallation,
  githubApiBase,
  githubAppJwt,
  githubInstallUrl,
  githubManifestFormUrl,
  GITHUB_WEB,
  GITLAB_CALLBACK_PATH,
  GITLAB_WEB,
  gitlabAuthorizeUrl,
  gitlabTokenNeedsRefresh,
  INSPECT_IMAGE,
  INSPECT_TIMEOUT_MS,
  inspectEnv,
  isSshGitUrl,
  listGithubBranches,
  listGitlabBranches,
  listGitlabProjects,
  listInstallationRepos,
  listUserInstallationIds,
  parseInspectOutput,
  refreshGitlabToken,
  renderInspectProgram,
  requestJson,
  signState,
  verifyState,
  type FetchLike,
  type InspectResult,
  type ProviderBranch,
  type ProviderRepo,
} from './git-providers';

type Deps = { db: DB; hub: AgentHub; auth: Auth };

/** HMAC key for OAuth `state`, derived from the vault key (never the key itself). */
function stateKey(): string {
  const k = process.env.SWARMY_SECRET_KEY;
  if (!k || !isVaultConfigured()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'SWARMY_SECRET_KEY is not set — swarmy cannot store git credentials without its vault.',
    });
  }
  return createHmac('sha256', k).update('swarmy:git-oauth-state:v1').digest('hex');
}

// ── views (secrets never included) ──────────────────────────────────────────

export type GitConnectionKind = 'github' | 'gitlab' | 'gitea' | 'generic';

export interface GitConnectionView {
  id: string;
  kind: GitConnectionKind;
  displayName: string;
  baseUrl: string;
  account: string | null;
  status: string;
  repoCount: number;
  createdAt: string;
}

export interface GithubAppView {
  registered: boolean;
  slug: string | null;
  name: string | null;
  htmlUrl: string | null;
  webBase: string;
}

const KIND_TO_DB = {
  github: 'GITHUB',
  gitlab: 'GITLAB',
  gitea: 'GITEA',
  generic: 'GENERIC',
} as const;
const kindFromDb = (k: string): GitConnectionKind => k.toLowerCase() as GitConnectionKind;

function toConnectionView(r: {
  id: string;
  kind: string;
  displayName: string;
  baseUrl: string;
  account: string | null;
  status: string;
  createdAt: Date;
  _count?: { repos: number };
}): GitConnectionView {
  return {
    id: r.id,
    kind: kindFromDb(r.kind),
    displayName: r.displayName,
    baseUrl: r.baseUrl,
    account: r.account,
    status: r.status,
    repoCount: r._count?.repos ?? 0,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listConnections(ctx: OrgContext): Promise<GitConnectionView[]> {
  const rows = await ctx.db.gitConnection.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { repos: true } } },
  });
  return rows.map(toConnectionView);
}

/** One connection (org-scoped, secrets never included) — the REST/Terraform detail read. */
export async function getConnection(ctx: OrgContext, id: string): Promise<GitConnectionView> {
  const row = await ctx.db.gitConnection.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    include: { _count: { select: { repos: true } } },
  });
  if (!row) throw notFound('git connection', id);
  return toConnectionView(row);
}

async function loadConnection(ctx: OrgContext, id: string) {
  const row = await ctx.db.gitConnection.findFirst({
    where: { id, orgId: ctx.activeOrgId },
    include: { githubApp: true },
  });
  if (!row) throw notFound('git connection', id);
  return row;
}

export async function removeConnection(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const row = await loadConnection(ctx, id);
  await ctx.db.gitConnection.delete({ where: { id: row.id } });
  await writeAudit(ctx, {
    action: 'git.connection.remove',
    targetType: 'gitConnection',
    targetId: row.id,
    metadata: { kind: kindFromDb(row.kind), account: row.account, baseUrl: row.baseUrl },
  });
  return { id: row.id, removed: true };
}

// ── GitHub App: manifest flow ────────────────────────────────────────────────

async function loadGithubApp(db: DB, webBase = GITHUB_WEB) {
  return db.gitHubApp.findFirst({ where: { webBase }, orderBy: { createdAt: 'asc' } });
}

export async function getGithubApp(ctx: OrgContext, webBase = GITHUB_WEB): Promise<GithubAppView> {
  const app = await loadGithubApp(ctx.db, webBase);
  return {
    registered: Boolean(app),
    slug: app?.slug ?? null,
    name: app?.name ?? null,
    htmlUrl: app?.htmlUrl ?? null,
    webBase,
  };
}

/**
 * Step 1: what the dashboard POSTs to GitHub (a form with one `manifest`
 * field) to register this controller's App. Refused when one already exists —
 * then the next step is simply installing it (`githubInstallLink`).
 */
export async function startGithubManifest(
  ctx: OrgContext,
  input: { githubOrg?: string; name?: string; webBase?: string } = {},
): Promise<{ postUrl: string; manifest: string }> {
  const webBase = input.webBase ?? GITHUB_WEB;
  if (await loadGithubApp(ctx.db, webBase)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This controller already has a GitHub App — install it instead.',
    });
  }
  const state = signState(stateKey(), {
    purpose: 'github-manifest',
    orgId: ctx.activeOrgId,
    userId: ctx.user.id,
    ref: webBase,
  });
  const manifest = buildGithubManifest({ controllerUrl: controllerPublicUrl(), name: input.name });
  return {
    postUrl: githubManifestFormUrl(state, { webBase, githubOrg: input.githubOrg }),
    manifest: JSON.stringify(manifest),
  };
}

/** Step 2 (callback, no session): exchange the manifest code, vault the App. Returns where to send the browser next. */
export async function completeGithubManifest(
  deps: Deps,
  input: { code: string; state: string },
): Promise<{ installUrl: string }> {
  const s = verifyState(stateKey(), input.state, 'github-manifest');
  if (!s)
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'This GitHub link expired or was not started here — try again.',
    });
  const webBase = s.ref ?? GITHUB_WEB;
  const conv = await convertManifest(gitFetch, githubApiBase(webBase), input.code);
  const app = await deps.db.gitHubApp.create({
    data: {
      webBase,
      appId: conv.id,
      slug: conv.slug,
      name: conv.name,
      htmlUrl: conv.html_url,
      ownerLogin: conv.owner?.login ?? null,
      clientId: conv.client_id,
      clientSecretEnc: encryptSecret(conv.client_secret),
      privateKeyEnc: encryptSecret(conv.pem),
      webhookSecretEnc: encryptSecret(conv.webhook_secret),
      createdByOrgId: s.orgId,
    },
  });
  const ctx = systemContext(deps, s.orgId);
  await writeAudit(ctx, {
    action: 'git.githubApp.register',
    targetType: 'githubApp',
    targetId: app.id,
    actorType: 'user',
    actorId: s.userId,
    metadata: { slug: app.slug, appId: app.appId, webBase },
  });
  const next = signState(stateKey(), {
    purpose: 'github-setup',
    orgId: s.orgId,
    userId: s.userId,
    ref: app.id,
  });
  return { installUrl: githubInstallUrl(app.slug, next, webBase) };
}

/** The "Install on more repos / another account" link for an org. */
export async function githubInstallLink(
  ctx: OrgContext,
  webBase = GITHUB_WEB,
): Promise<{ url: string }> {
  const app = await loadGithubApp(ctx.db, webBase);
  if (!app)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Register the GitHub App first.' });
  const state = signState(stateKey(), {
    purpose: 'github-setup',
    orgId: ctx.activeOrgId,
    userId: ctx.user.id,
    ref: app.id,
  });
  return { url: githubInstallUrl(app.slug, state, webBase) };
}

/**
 * Step 3 (callback after install, no session): prove the installing user can
 * see `installationId` with THEIR OAuth token, then bind it to the org in the
 * signed state. An installation already bound to another org is refused.
 */
export async function completeGithubSetup(
  deps: Deps,
  input: { code: string; installationId: string; state: string },
): Promise<{ connectionId: string }> {
  const s = verifyState(stateKey(), input.state, 'github-setup');
  if (!s)
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'This GitHub link expired or was not started here — try again.',
    });
  if (!/^\d+$/.test(input.installationId))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid installation id' });
  const app = s.ref
    ? await deps.db.gitHubApp.findUnique({ where: { id: s.ref } })
    : await loadGithubApp(deps.db);
  if (!app)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitHub App not registered.' });
  const apiBase = githubApiBase(app.webBase);

  const userToken = await exchangeOAuthCode(gitFetch, {
    webBase: app.webBase,
    clientId: app.clientId,
    clientSecret: decryptSecret(app.clientSecretEnc),
    code: input.code,
  });
  const visible = await listUserInstallationIds(gitFetch, apiBase, userToken);
  if (!visible.includes(Number(input.installationId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'That GitHub installation is not visible to you.',
    });
  }
  const jwt = githubAppJwt(app.appId, decryptSecret(app.privateKeyEnc));
  const inst = await getInstallation(gitFetch, apiBase, jwt, input.installationId);

  const existing = await deps.db.gitConnection.findUnique({
    where: {
      githubAppId_installationId: { githubAppId: app.id, installationId: input.installationId },
    },
  });
  if (existing && existing.orgId !== s.orgId) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'That GitHub installation is already connected to another workspace.',
    });
  }
  const account = inst.account?.login ?? null;
  const row = existing
    ? await deps.db.gitConnection.update({
        where: { id: existing.id },
        data: { account, status: 'active' },
      })
    : await deps.db.gitConnection.create({
        data: {
          orgId: s.orgId,
          kind: 'GITHUB',
          displayName: account ? `GitHub · ${account}` : 'GitHub',
          baseUrl: app.webBase,
          githubAppId: app.id,
          installationId: input.installationId,
          account,
          createdById: s.userId,
        },
      });
  await writeAudit(systemContext(deps, s.orgId), {
    action: 'git.connection.add',
    targetType: 'gitConnection',
    targetId: row.id,
    actorType: 'user',
    actorId: s.userId,
    metadata: { kind: 'github', account, installationId: input.installationId },
  });
  return { connectionId: row.id };
}

// ── GitLab / Gitea / generic connections ────────────────────────────────────

export type CreateConnectionInput =
  | { kind: 'gitlab'; baseUrl?: string; mode: 'oauth'; clientId: string; clientSecret: string }
  | { kind: 'gitlab'; baseUrl?: string; mode: 'token'; token: string }
  | {
      kind: 'gitea' | 'generic';
      baseUrl: string;
      displayName?: string;
      token?: string;
      tokenUser?: string;
    };

/**
 * Create a non-GitHub connection. GitLab OAuth returns the authorize URL to
 * send the browser to (connection is `pending` until the callback); a token
 * connection is verified against the provider before it is saved.
 */
export async function createConnection(
  ctx: OrgContext,
  input: CreateConnectionInput,
): Promise<{ connection: GitConnectionView; authorizeUrl?: string }> {
  const baseUrl = (input.baseUrl ?? GITLAB_WEB).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'baseUrl must be http(s)' });
  let account: string | null = null;

  if (input.kind === 'gitlab' && input.mode === 'token') {
    const me = await requestJson<{ username: string }>(gitFetch, `${baseUrl}/api/v4/user`, {
      headers: { authorization: `Bearer ${input.token}` },
    }).catch(async () => {
      // Project/group access tokens can't read /user — accept if they can list projects.
      await listGitlabProjects(gitFetch, baseUrl, input.token);
      return { username: 'access token' };
    });
    account = me.username;
  }

  const row = await ctx.db.gitConnection.create({
    data: {
      orgId: ctx.activeOrgId,
      kind: KIND_TO_DB[input.kind],
      displayName:
        input.kind === 'gitlab'
          ? `GitLab · ${new URL(baseUrl).host}`
          : (input.displayName ??
            `${input.kind === 'gitea' ? 'Gitea' : 'Git'} · ${new URL(baseUrl).host}`),
      baseUrl,
      account,
      createdById: ctx.user.id,
      ...(input.kind === 'gitlab' && input.mode === 'oauth'
        ? {
            clientId: input.clientId,
            clientSecretEnc: encryptSecret(input.clientSecret),
            status: 'pending',
            tokenUser: 'oauth2',
          }
        : {}),
      ...(input.kind === 'gitlab' && input.mode === 'token'
        ? { accessTokenEnc: encryptSecret(input.token), tokenUser: 'oauth2' }
        : {}),
      ...(input.kind !== 'gitlab' && input.token
        ? { accessTokenEnc: encryptSecret(input.token), tokenUser: input.tokenUser ?? 'git' }
        : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'git.connection.add',
    targetType: 'gitConnection',
    targetId: row.id,
    metadata: {
      kind: input.kind,
      baseUrl,
      mode: 'mode' in input ? input.mode : input.token ? 'token' : 'none',
    },
  });
  let authorizeUrl: string | undefined;
  if (input.kind === 'gitlab' && input.mode === 'oauth') {
    const state = signState(stateKey(), {
      purpose: 'gitlab-oauth',
      orgId: ctx.activeOrgId,
      userId: ctx.user.id,
      ref: row.id,
    });
    authorizeUrl = gitlabAuthorizeUrl({
      baseUrl,
      clientId: input.clientId,
      redirectUri: `${controllerPublicUrl()}${GITLAB_CALLBACK_PATH}`,
      state,
    });
  }
  return { connection: toConnectionView(row), ...(authorizeUrl ? { authorizeUrl } : {}) };
}

/** GitLab OAuth callback (no session): store the grant's tokens on the pending connection. */
export async function completeGitlabOAuth(
  deps: Deps,
  input: { code: string; state: string },
): Promise<{ connectionId: string }> {
  const s = verifyState(stateKey(), input.state, 'gitlab-oauth');
  if (!s?.ref)
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'This GitLab link expired or was not started here — try again.',
    });
  const conn = await deps.db.gitConnection.findFirst({
    where: { id: s.ref, orgId: s.orgId, kind: 'GITLAB' },
  });
  if (!conn?.clientId || !conn.clientSecretEnc) throw notFound('git connection', s.ref);
  const tokens = await exchangeGitlabCode(gitFetch, {
    baseUrl: conn.baseUrl,
    clientId: conn.clientId,
    clientSecret: decryptSecret(conn.clientSecretEnc),
    code: input.code,
    redirectUri: `${controllerPublicUrl()}${GITLAB_CALLBACK_PATH}`,
  });
  const me = await requestJson<{ username: string }>(gitFetch, `${conn.baseUrl}/api/v4/user`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  }).catch(() => ({ username: null as string | null }));
  await deps.db.gitConnection.update({
    where: { id: conn.id },
    data: {
      status: 'active',
      account: me.username,
      accessTokenEnc: encryptSecret(tokens.access_token),
      refreshTokenEnc: encryptSecret(tokens.refresh_token),
      tokenExpiresAt: new Date((tokens.created_at + tokens.expires_in) * 1000),
    },
  });
  await writeAudit(systemContext(deps, s.orgId), {
    action: 'git.connection.authorize',
    targetType: 'gitConnection',
    targetId: conn.id,
    actorType: 'user',
    actorId: s.userId,
    metadata: { kind: 'gitlab', account: me.username },
  });
  return { connectionId: conn.id };
}

// ── repo + branch picker ────────────────────────────────────────────────────

export async function listProviderRepos(
  ctx: OrgContext,
  input: { connectionId: string; search?: string },
): Promise<ProviderRepo[]> {
  const conn = await loadConnection(ctx, input.connectionId);
  const creds = await connectionCredentials(ctx.db, conn);
  if (!creds.token) return [];
  if (conn.kind === 'GITHUB') {
    return listInstallationRepos(gitFetch, githubApiBase(conn.baseUrl), creds.token, {
      search: input.search,
    });
  }
  if (conn.kind === 'GITLAB')
    return listGitlabProjects(gitFetch, conn.baseUrl, creds.token, { search: input.search });
  // Gitea: the same search endpoint shape GitHub's REST uses.
  if (conn.kind === 'GITEA') {
    const q = new URLSearchParams({ limit: '50', ...(input.search ? { q: input.search } : {}) });
    const r = await requestJson<{
      data: Array<{
        id: number;
        full_name: string;
        clone_url: string;
        html_url: string;
        default_branch: string;
        private: boolean;
      }>;
    }>(gitFetch, `${conn.baseUrl}/api/v1/repos/search?${q.toString()}`, {
      headers: { authorization: `token ${creds.token}` },
    });
    return r.data.map((x) => ({
      id: String(x.id),
      fullName: x.full_name,
      cloneUrl: x.clone_url,
      htmlUrl: x.html_url,
      defaultBranch: x.default_branch,
      private: x.private,
    }));
  }
  return []; // generic git has no listing API — the URL is typed.
}

export async function listProviderBranches(
  ctx: OrgContext,
  input: { connectionId: string; repo: string },
): Promise<ProviderBranch[]> {
  const conn = await loadConnection(ctx, input.connectionId);
  const creds = await connectionCredentials(ctx.db, conn);
  if (!creds.token) return [];
  if (conn.kind === 'GITHUB')
    return listGithubBranches(gitFetch, githubApiBase(conn.baseUrl), creds.token, input.repo);
  if (conn.kind === 'GITLAB')
    return listGitlabBranches(gitFetch, conn.baseUrl, creds.token, input.repo);
  if (conn.kind === 'GITEA') {
    const r = await requestJson<Array<{ name: string; commit: { id: string } }>>(
      gitFetch,
      `${conn.baseUrl}/api/v1/repos/${input.repo}/branches?limit=50`,
      { headers: { authorization: `token ${creds.token}` } },
    );
    return r.map((b) => ({ name: b.name, sha: b.commit.id }));
  }
  return [];
}

// ── linking a repo (the app binding) ────────────────────────────────────────

export interface LinkRepoInput {
  connectionId?: string;
  /** Provider repo (from the picker) — or a raw `url` for generic git. */
  repo?: { id: string; fullName: string; cloneUrl: string };
  url?: string;
  branch: string;
  configPath?: string;
  /** Generic SSH remotes: mint a deploy key and show its public half once. */
  deployKey?: boolean;
}

export interface LinkedRepoView {
  id: string;
  url: string;
  branch: string;
  configPath: string;
  fullName: string | null;
  /** Generic webhook URL + secret (shown once) when the provider can't be configured automatically. */
  webhook: { url: string; secret: string } | null;
  /** Public deploy key to paste into the git host (shown once). */
  deployKeyPublic: string | null;
}

export async function linkRepo(ctx: OrgContext, input: LinkRepoInput): Promise<LinkedRepoView> {
  const conn = input.connectionId ? await loadConnection(ctx, input.connectionId) : null;
  const url = input.repo?.cloneUrl ?? input.url;
  if (!url)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'pick a repository or give its URL' });
  const configPath = (input.configPath ?? 'swarmy.yaml').replace(/^\.?\/+/, '');
  const webhookSecret = randomToken('whsec');
  const key =
    input.deployKey || (!conn && isSshGitUrl(url))
      ? generateDeployKey(`swarmy@${ctx.activeOrgId.slice(0, 8)}`)
      : null;

  const provider = conn ? (conn.kind === 'GITHUB' ? 'GITHUB' : conn.kind) : 'GENERIC';
  const row = await ctx.db.gitRepo.create({
    data: {
      orgId: ctx.activeOrgId,
      provider,
      url,
      branch: input.branch,
      configPath,
      connectionId: conn?.id ?? null,
      externalRepoId: input.repo?.id ?? null,
      fullName: input.repo?.fullName ?? null,
      webhookSecretEnc: encryptSecret(webhookSecret),
      ...(key
        ? { deployKeyEnc: encryptSecret(key.privateKey), deployKeyPublic: key.publicKey }
        : {}),
    },
  });

  // GitHub: the App's single webhook already covers every installed repo.
  // GitLab: register the project hook ourselves. Others: hand back URL + secret.
  let webhook: LinkedRepoView['webhook'] = null;
  const hookUrl = `${controllerPublicUrl()}/webhooks/git/${row.id}`;
  if (conn?.kind === 'GITLAB' && input.repo) {
    const creds = await connectionCredentials(ctx.db, conn);
    if (creds.token) {
      await createGitlabProjectHook(gitFetch, conn.baseUrl, creds.token, input.repo.id, {
        url: hookUrl,
        secretToken: webhookSecret,
      }).catch(() => {
        webhook = { url: hookUrl, secret: webhookSecret }; // couldn't auto-register — show it
      });
    }
  } else if (conn?.kind !== 'GITHUB') {
    webhook = { url: hookUrl, secret: webhookSecret };
  }

  await writeAudit(ctx, {
    action: 'git.repo.link',
    targetType: 'gitRepo',
    targetId: row.id,
    metadata: {
      url,
      branch: input.branch,
      configPath,
      connectionId: conn?.id ?? null,
      deployKey: Boolean(key),
    },
  });
  return {
    id: row.id,
    url,
    branch: row.branch,
    configPath,
    fullName: row.fullName,
    webhook,
    deployKeyPublic: key?.publicKey ?? null,
  };
}

// ── git.inspect ──────────────────────────────────────────────────────────────

/**
 * Read a commit on a Builder node (container.runOnce): the requested files,
 * notable file names, and paths changed since `baseSha`. The controller never
 * clones; credentials ride the container env.
 */
export async function inspectCommit(
  ctx: OrgContext,
  input: {
    repoId: string;
    ref?: string;
    baseSha?: string;
    paths?: string[];
    fallbackBranch?: string;
  },
): Promise<InspectResult & { configPaths: string[] }> {
  const repo = await ctx.db.gitRepo.findFirst({
    where: { id: input.repoId, orgId: ctx.activeOrgId },
  });
  if (!repo) throw notFound('repo', input.repoId);
  const creds = await repoCredentials(ctx.db, repo);
  return runInspect(ctx, {
    url: repo.url,
    ref: input.ref ?? repo.branch,
    paths: input.paths ?? [repo.configPath],
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    ...(input.fallbackBranch ? { fallbackBranch: input.fallbackBranch } : {}),
    creds,
  });
}

/**
 * Read a repo BEFORE it is linked (the wizard's "we found swarmy.yaml in
 * services/orders"): through a connection's credentials, or a public URL.
 */
export async function inspectSource(
  ctx: OrgContext,
  input: { connectionId?: string; cloneUrl: string; ref: string; paths?: string[] },
): Promise<InspectResult & { configPaths: string[] }> {
  let creds: GitCredentials = {};
  if (input.connectionId) {
    const conn = await loadConnection(ctx, input.connectionId);
    creds = await connectionCredentials(ctx.db, conn);
  }
  return runInspect(ctx, {
    url: input.cloneUrl,
    ref: input.ref,
    paths: input.paths ?? ['swarmy.yaml'],
    creds,
  });
}

async function runInspect(
  ctx: OrgContext,
  input: {
    url: string;
    ref: string;
    paths: string[];
    baseSha?: string;
    fallbackBranch?: string;
    creds: GitCredentials;
  },
): Promise<InspectResult & { configPaths: string[] }> {
  const { creds, paths } = input;
  const req = {
    url: input.url,
    ref: input.ref,
    paths,
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    ...(input.fallbackBranch ? { fallbackBranch: input.fallbackBranch } : {}),
    ...creds,
  };
  let program: string;
  try {
    program = renderInspectProgram(req);
  } catch (e) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const node = await resolveBuilderNode(ctx);
  let res: RunOnceResult;
  try {
    res = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      {
        image: INSPECT_IMAGE,
        entrypoint: ['sh', '-c'],
        cmd: [program],
        env: inspectEnv(req),
        timeoutMs: INSPECT_TIMEOUT_MS,
      },
      { timeoutMs: INSPECT_TIMEOUT_MS + 30_000 },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  let parsed: InspectResult;
  try {
    parsed = parseInspectOutput(redactOutput(res.output, creds), paths);
  } catch (e) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return { ...parsed, configPaths: configPathsIn(parsed.tree) };
}

/**
 * Change a linked repo's branch or swarmy.yaml path in place — the webhook
 * secret, deploy key and provider hook stay as they are.
 */
export async function updateRepo(
  ctx: OrgContext,
  input: { id: string; branch?: string; configPath?: string },
): Promise<{ id: string; branch: string; configPath: string }> {
  const repo = await ctx.db.gitRepo.findFirst({ where: { id: input.id, orgId: ctx.activeOrgId } });
  if (!repo) throw notFound('repo', input.id);
  const data = {
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.configPath ? { configPath: input.configPath.replace(/^\.?\/+/, '') } : {}),
  };
  const row = await ctx.db.gitRepo.update({ where: { id: repo.id }, data });
  await writeAudit(ctx, {
    action: 'git.repo.update',
    targetType: 'gitRepo',
    targetId: repo.id,
    metadata: { from: { branch: repo.branch, configPath: repo.configPath }, to: data },
  });
  return { id: row.id, branch: row.branch, configPath: row.configPath };
}

function redactOutput(output: string, creds: GitCredentials): string {
  let out = output;
  for (const s of [creds.token, creds.sshKey]) if (s) out = out.split(s).join('***');
  return out;
}
