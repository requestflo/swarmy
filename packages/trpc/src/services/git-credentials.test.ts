import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { encryptSecret } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import { inspectSource, linkRepo } from './git-connections.service';
import { connectionCredentials, repoCredentials, setGitFetchForTests } from './git-credentials';
import type { FetchLike } from './git-providers';

const ENV = { SWARMY_SECRET_KEY: 'test-vault-key-0123456789abcdef', CONTROLLER_PUBLIC_URL: 'https://swarmy.test' };
const prevEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
beforeAll(() => Object.assign(process.env, ENV));
afterAll(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setGitFetchForTests(null);
});

const pem = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function githubConn() {
  return {
    id: 'c1',
    kind: 'GITHUB',
    status: 'active',
    displayName: 'GitHub · northwind',
    baseUrl: 'https://github.com',
    installationId: '777',
    githubApp: { appId: 99, webBase: 'https://github.com', privateKeyEnc: encryptSecret(pem()) },
  };
}

/** Records every token request body; answers with a token named after the call. */
function tokenFetch() {
  const bodies: unknown[] = [];
  const fn: FetchLike = async (_url, init) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    const expires_at = new Date(Date.now() + 3600_000).toISOString();
    return new Response(JSON.stringify({ token: `ghs_${bodies.length}`, expires_at }));
  };
  return { fn, bodies };
}

const dbWith = (conn: unknown) =>
  ({
    gitConnection: { findUnique: async () => conn, findFirst: async () => conn },
    gitRepo: { create: async () => ({ id: 'r1' }) },
    auditLog: { create: async () => ({}) },
  }) as unknown as DB;

describe('M7: per-repo, least-privilege GitHub installation tokens', () => {
  it('a build/inspect token covers only that repo, read-only; each scope is minted and cached once', async () => {
    const conn = githubConn();
    const db = dbWith(conn);
    const f = tokenFetch();
    setGitFetchForTests(f.fn);
    const repo = { url: 'https://github.com/northwind/shop.git', connectionId: 'c1', tokenEnc: null, deployKeyEnc: null, provider: 'GITHUB' };
    expect(await repoCredentials(db, repo)).toEqual({ token: 'ghs_1', tokenUser: 'x-access-token' });
    expect(await repoCredentials(db, repo)).toEqual({ token: 'ghs_1', tokenUser: 'x-access-token' });
    expect(await connectionCredentials(db, conn as never)).toEqual({ token: 'ghs_2', tokenUser: 'x-access-token' });
    expect(f.bodies).toEqual([
      { repositories: ['shop'], permissions: { contents: 'read', metadata: 'read' } },
      { permissions: { metadata: 'read' } },
    ]);
  });

  it('refuses to hand a connection token to a repo URL on another host', async () => {
    const db = dbWith(githubConn());
    const f = tokenFetch();
    setGitFetchForTests(f.fn);
    const repo = { url: 'https://evil.example/northwind/shop.git', connectionId: 'c1', tokenEnc: null, deployKeyEnc: null, provider: 'GITHUB' };
    await expect(repoCredentials(db, repo)).rejects.toThrow('is not on github.com');
    expect(f.bodies).toHaveLength(0); // nothing minted
  });
});

describe('M7: link and inspect only accept the connection host', () => {
  const ctx = (db: DB) => ({ db, user: { id: 'u1' }, activeOrgId: 'org-a' }) as unknown as OrgContext;

  it('linkRepo refuses a picked repo whose clone URL points elsewhere', async () => {
    const db = dbWith(githubConn());
    const repo = { id: '1', fullName: 'northwind/shop', cloneUrl: 'https://evil.example/northwind/shop.git' };
    await expect(linkRepo(ctx(db), { connectionId: 'c1', repo, branch: 'main' })).rejects.toThrow(
      'only reaches repositories there',
    );
  });

  it('inspectSource refuses before minting or dispatching anything', async () => {
    const db = dbWith(githubConn());
    const f = tokenFetch();
    setGitFetchForTests(f.fn);
    await expect(
      inspectSource(ctx(db), { connectionId: 'c1', cloneUrl: 'git@evil.example:northwind/shop.git', ref: 'main' }),
    ).rejects.toThrow('is not on github.com');
    expect(f.bodies).toHaveLength(0);
  });
});
