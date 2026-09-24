import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from '../app';
import { gitConnectionToDto, gitRepoToDto, linkedRepoToDto, toCreateConnectionInput } from './git';

/**
 * /git/* REST parity: the body→service-input adapter refuses the browser-only
 * kinds, the admin gate mirrors tRPC's `adminProcedure`, and no read DTO can
 * carry a credential.
 */

type Role = 'owner' | 'admin' | 'member';

const connRow = {
  id: 'gc1',
  orgId: 'org1',
  kind: 'GITEA',
  displayName: 'Gitea · git.example.com',
  baseUrl: 'https://git.example.com',
  account: null,
  status: 'active',
  accessTokenEnc: 'enc:secret',
  clientSecretEnc: 'enc:client',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  _count: { repos: 2 },
};
const repoRow = {
  id: 'gr1',
  orgId: 'org1',
  provider: 'GENERIC',
  url: 'git@example.com:acme/app.git',
  branch: 'main',
  tokenEnc: 'enc:tok',
  webhookSecretEnc: 'enc:wh',
  deployKeyEnc: 'enc:key',
  autodeploy: false,
  serviceId: null,
  connectionId: null,
  fullName: null,
  configPath: 'deploy/swarmy.yaml',
  createdAt: new Date('2026-09-02T00:00:00Z'),
};

function appFor(role: Role) {
  const db = new Proxy(
    {
      gitConnection: {
        findMany: async () => [connRow],
        findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'gc1' ? connRow : null),
      },
      gitRepo: {
        findMany: async () => [repoRow],
        findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'gr1' ? repoRow : null),
      },
      auditLog: { create: async () => ({}) },
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        k in t ? t[k] : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
    },
  );
  const ctx = {
    db,
    hub: {},
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({
    resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: 'k1', scopes: ['write'] } }),
  });
}

async function call(role: Role, method: string, path: string, body?: unknown) {
  const res = await appFor(role).request(path, {
    method,
    headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('toCreateConnectionInput', () => {
  it('refuses GitHub and GitLab OAuth (browser round-trip) with BROWSER_FLOW_REQUIRED', () => {
    for (const b of [{ kind: 'github' as const }, { kind: 'gitlab' as const, mode: 'oauth' as const }]) {
      try {
        toCreateConnectionInput(b);
        throw new Error('expected refusal');
      } catch (e) {
        expect((e as { code: string }).code).toBe('UNPROCESSABLE_CONTENT');
        expect((e as { cause: { swarmyCode: string } }).cause.swarmyCode).toBe('BROWSER_FLOW_REQUIRED');
      }
    }
  });
  it('maps a GitLab token connection (mode defaults to token)', () => {
    expect(toCreateConnectionInput({ kind: 'gitlab', token: 'glpat-12345678' })).toEqual({
      kind: 'gitlab',
      mode: 'token',
      token: 'glpat-12345678',
    });
  });
  it('requires a token for GitLab and a base_url for gitea/generic', () => {
    expect(() => toCreateConnectionInput({ kind: 'gitlab' })).toThrow(/token/);
    expect(() => toCreateConnectionInput({ kind: 'gitea' })).toThrow(/base_url/);
    expect(() => toCreateConnectionInput({ kind: 'generic', base_url: 'https://x.dev', mode: 'token' })).toThrow(/mode/);
  });
  it('maps gitea/generic with optional token', () => {
    expect(
      toCreateConnectionInput({ kind: 'gitea', base_url: 'https://git.example.com', token: 't', token_user: 'bot' }),
    ).toEqual({ kind: 'gitea', baseUrl: 'https://git.example.com', token: 't', tokenUser: 'bot' });
  });
});

describe('/git REST routes', () => {
  it('POST /git/connections with kind=github → 422 problem', async () => {
    const r = await call('admin', 'POST', '/git/connections', { kind: 'github' });
    expect(r.status).toBe(422);
    expect(r.json.swarmy_code).toBe('BROWSER_FLOW_REQUIRED');
  });
  it('POST /git/connections and /git/repos are admin-only (adminProcedure twin)', async () => {
    const a = await call('member', 'POST', '/git/connections', { kind: 'gitea', base_url: 'https://git.example.com' });
    expect(a.status).toBe(403);
    expect(a.json.swarmy_code).toBe('POLICY_DENIED');
    const b = await call('member', 'POST', '/git/repos', { url: 'https://x.dev/a.git', branch: 'main' });
    expect(b.status).toBe(403);
  });
  it('POST /git/repos needs exactly one of repo/url', async () => {
    const r = await call('admin', 'POST', '/git/repos', { branch: 'main' });
    expect(r.status).toBe(400);
  });
  it('GET /git/connections + /git/repos/{id} never carry a credential', async () => {
    const list = await call('member', 'GET', '/git/connections');
    expect(list.status).toBe(200);
    expect((list.json.data as unknown[])[0]).toEqual({
      id: 'gc1',
      kind: 'gitea',
      display_name: 'Gitea · git.example.com',
      base_url: 'https://git.example.com',
      account: null,
      status: 'active',
      repo_count: 2,
      created_at: '2026-09-01T00:00:00.000Z',
    });
    const repo = await call('member', 'GET', '/git/repos/gr1');
    expect(repo.status).toBe(200);
    expect(repo.json).toMatchObject({ id: 'gr1', kind: 'generic', config_path: 'deploy/swarmy.yaml', has_token: true });
    expect(JSON.stringify([list.json, repo.json])).not.toContain('enc:');
  });
  it('GET /git/connections/{id} → 404 problem for another org / missing row', async () => {
    const r = await call('admin', 'GET', '/git/connections/nope');
    expect(r.status).toBe(404);
    expect(r.json.swarmy_code).toBe('NOT_FOUND');
  });
});

describe('git mappers', () => {
  it('snake_cases views and passes write-once fields through only on link', () => {
    expect(
      linkedRepoToDto({
        id: 'r',
        url: 'u',
        branch: 'main',
        configPath: 'swarmy.yaml',
        fullName: null,
        webhook: { url: 'https://c/webhooks/git/r', secret: 'whsec_x' },
        deployKeyPublic: 'ssh-ed25519 AAA',
      }),
    ).toEqual({
      id: 'r',
      url: 'u',
      branch: 'main',
      config_path: 'swarmy.yaml',
      full_name: null,
      webhook: { url: 'https://c/webhooks/git/r', secret: 'whsec_x' },
      deploy_key_public: 'ssh-ed25519 AAA',
    });
    expect(Object.keys(gitRepoToDto({
      id: 'r', provider: 'github', url: 'u', branch: 'b', autodeploy: false, serviceId: null, hasToken: false,
      createdAt: 'now', kind: 'gitea', connectionId: 'c', fullName: 'a/b', configPath: 'swarmy.yaml',
    }))).not.toContain('webhook');
    expect(gitConnectionToDto({
      id: 'c', kind: 'gitlab', displayName: 'd', baseUrl: 'b', account: 'me', status: 'active', repoCount: 0, createdAt: 'now',
    }).kind).toBe('gitlab');
  });
});
