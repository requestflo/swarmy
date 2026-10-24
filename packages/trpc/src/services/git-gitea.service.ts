/**
 * Gitea / Forgejo connections (git-apps Phase 4): a personal access token
 * (verified before it is saved) or an OAuth2 application (the browser
 * round-trips through the instance; the connection is `pending` until the
 * callback), the read-only "Test connection" probe, and the repo webhook.
 *
 * Same invariants as every provider: secrets vault-encrypted and never
 * returned, org-scoped rows, and every change audited (`git.connection.*`).
 */
import { TRPCError } from '@trpc/server';
import type { Auth } from '@swarmy/auth';
import { decryptSecret, encryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import type { AgentHub } from '../hub/types';
import { writeAudit } from './audit.service';
import { systemContext } from './cicd.service';
import { stateKey, toConnectionView, type GitConnectionView } from './git-connection-view';
import { connectionCredentials, controllerPublicUrl, gitFetch, type ConnectionRow } from './git-credentials';
import {
  createGiteaRepoHook,
  GITEA_CALLBACK_PATH,
  giteaAuthorizeUrl,
  giteaBase,
  giteaTokenExpiry,
  giteaTokenRequest,
  GitProviderError,
  probeGitea,
  signState,
  verifyState,
  type GiteaProbe,
} from './git-providers';

export type GiteaConnectionInput = { baseUrl: string; displayName?: string } & (
  | { mode: 'token'; token: string; tokenUser?: string }
  | { mode: 'oauth'; clientId: string; clientSecret: string }
  /** REST / older clients: an optional token (none = public repos only, nothing to list). */
  | { mode?: undefined; token?: string; tokenUser?: string }
);

export type GiteaTestResult = ({ ok: true } & GiteaProbe) | { ok: false; status: number | null; error: string };

const label = (p: Pick<GiteaProbe, 'flavor'> | null) => (p?.flavor === 'forgejo' ? 'Forgejo' : 'Gitea');

/** Plain words for a refused probe (the raw provider error stays out of the UI). */
function probeError(e: unknown, baseUrl: string): { status: number | null; error: string } {
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;
  if (!(e instanceof GitProviderError)) return { status: null, error: `Couldn’t reach ${host}.` };
  if (e.status === 401) return { status: 401, error: `${host} refused that token.` };
  if (e.status === 404) return { status: 404, error: `No Gitea or Forgejo API at ${host}/api/v1.` };
  return { status: e.status, error: `${host} answered ${e.status}.` };
}

/** "Test connection": is it Gitea/Forgejo, and what can the token do? Read-only; never saves. */
export async function testGiteaConnection(input: { baseUrl: string; token?: string }): Promise<GiteaTestResult> {
  const baseUrl = giteaBase(input.baseUrl);
  try {
    return { ok: true, ...(await probeGitea(gitFetch, baseUrl, input.token)) };
  } catch (e) {
    return { ok: false, ...probeError(e, baseUrl) };
  }
}

export async function createGiteaConnection(
  ctx: OrgContext,
  input: GiteaConnectionInput,
): Promise<{ connection: GitConnectionView; authorizeUrl?: string }> {
  const baseUrl = giteaBase(input.baseUrl);
  if (!/^https?:\/\//.test(baseUrl)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'baseUrl must be http(s)' });
  const token = input.mode === 'oauth' ? undefined : input.token;
  let probe: GiteaProbe | null = null;
  if (token) {
    probe = await probeGitea(gitFetch, baseUrl, token).catch((e: unknown) => {
      throw new TRPCError({ code: 'BAD_REQUEST', message: probeError(e, baseUrl).error });
    });
  } else {
    probe = await probeGitea(gitFetch, baseUrl).catch(() => null); // only to name it Gitea vs Forgejo
  }
  const row = await ctx.db.gitConnection.create({
    data: {
      orgId: ctx.activeOrgId,
      kind: 'GITEA',
      displayName: input.displayName ?? `${label(probe)} · ${new URL(baseUrl).host}`,
      baseUrl,
      account: probe?.account ?? null,
      createdById: ctx.user.id,
      ...(token ? { accessTokenEnc: encryptSecret(token), tokenUser: input.mode === 'oauth' ? 'oauth2' : (input.tokenUser ?? 'git') } : {}),
      ...(input.mode === 'oauth'
        ? { clientId: input.clientId, clientSecretEnc: encryptSecret(input.clientSecret), status: 'pending', tokenUser: 'oauth2' }
        : {}),
    },
  });
  const mode = input.mode ?? (token ? 'token' : 'none');
  await writeAudit(ctx, {
    action: 'git.connection.add',
    targetType: 'gitConnection',
    targetId: row.id,
    metadata: { kind: 'gitea', flavor: probe?.flavor ?? null, baseUrl, mode },
  });
  if (input.mode !== 'oauth') return { connection: toConnectionView(row) };
  const state = signState(stateKey(), { purpose: 'gitea-oauth', orgId: ctx.activeOrgId, userId: ctx.user.id, ref: row.id });
  const redirectUri = `${controllerPublicUrl()}${GITEA_CALLBACK_PATH}`;
  return {
    connection: toConnectionView(row),
    authorizeUrl: giteaAuthorizeUrl({ baseUrl, clientId: input.clientId, redirectUri, state }),
  };
}

/** OAuth callback (no session): trade the code for tokens on the pending connection. */
export async function completeGiteaOAuth(
  deps: { db: DB; hub: AgentHub; auth: Auth },
  input: { code: string; state: string },
): Promise<{ connectionId: string }> {
  const s = verifyState(stateKey(), input.state, 'gitea-oauth');
  if (!s?.ref) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This Gitea link expired or was not started here — try again.' });
  const conn = await deps.db.gitConnection.findFirst({ where: { id: s.ref, orgId: s.orgId, kind: 'GITEA' } });
  if (!conn?.clientId || !conn.clientSecretEnc) throw notFound('git connection', s.ref);
  const app = { baseUrl: conn.baseUrl, clientId: conn.clientId, clientSecret: decryptSecret(conn.clientSecretEnc) };
  const redirectUri = `${controllerPublicUrl()}${GITEA_CALLBACK_PATH}`;
  const t = await giteaTokenRequest(gitFetch, { ...app, redirectUri }, { grant_type: 'authorization_code', code: input.code });
  const probe = await probeGitea(gitFetch, conn.baseUrl, t.access_token).catch(() => null);
  await deps.db.gitConnection.update({
    where: { id: conn.id },
    data: {
      status: 'active',
      account: probe?.account ?? null,
      accessTokenEnc: encryptSecret(t.access_token),
      refreshTokenEnc: encryptSecret(t.refresh_token),
      tokenExpiresAt: giteaTokenExpiry(t),
    },
  });
  await writeAudit(systemContext(deps, s.orgId), {
    action: 'git.connection.authorize',
    targetType: 'gitConnection',
    targetId: conn.id,
    actorType: 'user',
    actorId: s.userId,
    metadata: { kind: 'gitea', account: probe?.account ?? null },
  });
  return { connectionId: conn.id };
}

/**
 * Register swarmy's webhook on a linked repo. Null when Gitea took it;
 * otherwise the URL + secret to paste by hand (no token, or not a repo admin).
 */
export async function registerGiteaHook(
  db: DB,
  conn: ConnectionRow,
  fullName: string,
  hook: { url: string; secret: string },
): Promise<{ url: string; secret: string } | null> {
  const creds = await connectionCredentials(db, conn);
  if (!creds.token) return hook;
  return createGiteaRepoHook(gitFetch, conn.baseUrl, creds.token, fullName, hook).then(
    () => null,
    () => hook,
  );
}
