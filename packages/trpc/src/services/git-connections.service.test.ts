import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { encryptSecret } from '@swarmy/core/crypto';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { gitBindNonce } from './git-browser-bind';
import {
  completeGithubSetup,
  githubInstallLink,
  inspectCommit,
  linkRepo,
  startGithubManifest,
} from './git-connections.service';
import { connectionCredentials, repoCredentials, setGitFetchForTests } from './git-credentials';
import { previewCommentBody, reportCommitStatus } from './git-feedback.service';
import { bindHash, signState, verifyState, type FetchLike } from './git-providers';

// Every test file shares one process: put back what this file sets, or a later
// file reads this controller address (the invitation links did, on CI's order).
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

const stateKey = () =>
  createHmac('sha256', process.env.SWARMY_SECRET_KEY ?? '')
    .update('swarmy:git-oauth-state:v1')
    .digest('hex');

/** A tiny in-memory Prisma stand-in covering the calls these services make. */
function fakeDb() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    gitHubApp: [],
    gitConnection: [],
    gitRepo: [],
    auditLog: [],
    node: [],
  };
  let n = 0;
  const match = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
        ? Object.entries(v as Record<string, unknown>).every(([k2, v2]) => row[k2] === v2)
        : row[k] === v,
    );
  const withApp = (row: Record<string, unknown> | undefined) =>
    row
      ? { ...row, githubApp: tables.gitHubApp?.find((a) => a.id === row.githubAppId) ?? null }
      : null;
  const model = (name: string) => ({
    findFirst: async (a: { where?: Record<string, unknown>; include?: unknown }) => {
      const r = tables[name]?.find((x) => match(x, a?.where));
      return name === 'gitConnection' ? withApp(r) : (r ?? null);
    },
    findUnique: async (a: { where: Record<string, unknown> }) => {
      const r = tables[name]?.find((x) => match(x, a.where));
      return name === 'gitConnection' ? withApp(r) : (r ?? null);
    },
    findMany: async (a: { where?: Record<string, unknown> } = {}) =>
      tables[name]?.filter((x) => match(x, a.where)) ?? [],
    create: async (a: { data: Record<string, unknown> }) => {
      const row = {
        id: `${name}-${++n}`,
        createdAt: new Date(),
        status: 'active',
        configPath: 'swarmy.yaml',
        ...a.data,
      };
      tables[name]?.push(row);
      return row;
    },
    update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = tables[name]?.find((x) => x.id === a.where.id);
      Object.assign(row ?? {}, a.data);
      return row;
    },
    delete: async (a: { where: { id: string } }) => {
      tables[name] = (tables[name] ?? []).filter((x) => x.id !== a.where.id);
    },
  });
  const db = Object.fromEntries(Object.keys(tables).map((k) => [k, model(k)])) as unknown as DB;
  return { db, tables };
}

function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key)
      return new Response(JSON.stringify({ message: `no route for ${url}` }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  };
  return { fn, calls };
}

const hub = (dispatch: AgentHub['dispatch'] = async () => ({}) as never) =>
  ({
    dispatch,
    isOnline: () => true,
    nodeInfoFor: () => ({ labels: { 'swarmy.node.builder': 'true' } }),
    agentBuildFor: () => undefined,
  }) as unknown as AgentHub;

function orgCtx(db: DB, h = hub()): OrgContext {
  return {
    db,
    hub: h,
    auth: {} as Auth,
    session: {} as never,
    user: { id: 'user-1' } as never,
    activeOrgId: 'org-a',
    resHeaders: new Headers(), // the tRPC response a browser flow sets its nonce cookie on
  } as unknown as OrgContext;
}

function seedApp(tables: ReturnType<typeof fakeDb>['tables']) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  tables.gitHubApp?.push({
    id: 'app-1',
    webBase: 'https://github.com',
    appId: 99,
    slug: 'swarmy-test',
    name: 'swarmy-test',
    htmlUrl: 'https://github.com/apps/swarmy-test',
    clientId: 'Iv1.x',
    clientSecretEnc: encryptSecret('client-secret'),
    privateKeyEnc: encryptSecret(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()),
    webhookSecretEnc: encryptSecret('whsec'),
    createdAt: new Date(),
  });
}

/** A browser nonce + the state hash it binds (what `bindBrowser` mints). */
const NONCE = 'f'.repeat(64);
const BIND = bindHash(NONCE);

describe('GitHub App manifest + setup', () => {
  it('refuses a second App on the same controller', async () => {
    const { db, tables } = fakeDb();
    const first = await startGithubManifest(orgCtx(db));
    expect(first.postUrl.startsWith('https://github.com/settings/apps/new?state=')).toBe(true);
    expect(JSON.parse(first.manifest).hook_attributes.url).toBe(
      'https://swarmy.test/webhooks/github',
    );
    seedApp(tables);
    await expect(startGithubManifest(orgCtx(db))).rejects.toThrow('already has a GitHub App');
  });

  it('binds an installation only when the installing user can see it', async () => {
    const { db, tables } = fakeDb();
    seedApp(tables);
    const state = signState(stateKey(), {
      purpose: 'github-setup',
      orgId: 'org-a',
      userId: 'user-1',
      ref: 'app-1',
      bind: BIND,
    });
    const deps = { db, hub: hub(), auth: {} as Auth };
    const browserNonce = NONCE;

    setGitFetchForTests(
      fakeFetch({
        '/login/oauth/access_token': { access_token: 'ghu_user' },
        '/user/installations': { installations: [{ id: 5 }] },
      }).fn,
    );
    await expect(
      completeGithubSetup(deps, { code: 'c', installationId: '777', state, browserNonce }),
    ).rejects.toThrow('not visible to you');
    expect(tables.gitConnection).toHaveLength(0);

    setGitFetchForTests(
      fakeFetch({
        '/login/oauth/access_token': { access_token: 'ghu_user' },
        '/user/installations': { installations: [{ id: 777 }] },
        '/app/installations/777': {
          id: 777,
          account: { login: 'northwind', type: 'Organization' },
          repository_selection: 'selected',
        },
      }).fn,
    );
    // M6: the same signed state finished in another browser (no / another cookie) binds nothing.
    for (const other of [null, 'e'.repeat(64)]) {
      await expect(
        completeGithubSetup(deps, { code: 'c', installationId: '777', state, browserNonce: other }),
      ).rejects.toThrow('not started in this browser');
    }
    expect(tables.gitConnection).toHaveLength(0);
    const { connectionId } = await completeGithubSetup(deps, {
      code: 'c',
      installationId: '777',
      state,
      browserNonce,
    });
    expect(tables.gitConnection?.[0]).toMatchObject({
      id: connectionId,
      orgId: 'org-a',
      kind: 'GITHUB',
      installationId: '777',
      account: 'northwind',
    });
    expect(tables.auditLog?.map((a) => a.action)).toEqual(['git.connection.add']);
  });

  it('never re-binds an installation that belongs to another org', async () => {
    const { db, tables } = fakeDb();
    seedApp(tables);
    tables.gitConnection?.push({
      id: 'c-b',
      orgId: 'org-b',
      kind: 'GITHUB',
      githubAppId: 'app-1',
      installationId: '777',
      status: 'active',
    });
    setGitFetchForTests(
      fakeFetch({
        '/login/oauth/access_token': { access_token: 'ghu_user' },
        '/user/installations': { installations: [{ id: 777 }] },
        '/app/installations/777': { id: 777, account: { login: 'x', type: 'User' } },
      }).fn,
    );
    const state = signState(stateKey(), {
      purpose: 'github-setup',
      orgId: 'org-a',
      userId: 'u',
      ref: 'app-1',
      bind: BIND,
    });
    await expect(
      completeGithubSetup(
        { db, hub: hub(), auth: {} as Auth },
        { code: 'c', installationId: '777', state, browserNonce: NONCE },
      ),
    ).rejects.toThrow('already connected to another workspace');
  });

  it('rejects a forged or wrong-purpose state', async () => {
    const { db } = fakeDb();
    const wrong = signState(stateKey(), { purpose: 'gitlab-oauth', orgId: 'org-a', userId: 'u', bind: BIND });
    await expect(
      completeGithubSetup(
        { db, hub: hub(), auth: {} as Auth },
        { code: 'c', installationId: '1', state: wrong, browserNonce: NONCE },
      ),
    ).rejects.toThrow('expired or was not started in this browser');
  });

  it('M6: starting a flow sets the __Host- nonce cookie the state is bound to', async () => {
    const { db, tables } = fakeDb();
    seedApp(tables);
    const ctx = orgCtx(db);
    const { url } = await githubInstallLink(ctx);
    const [cookie] = ctx.resHeaders?.getSetCookie() ?? [];
    expect(cookie).toMatch(/^__Host-swarmy-git-bind=[0-9a-f]{64}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
    const nonce = gitBindNonce(cookie?.split(';')[0]);
    const state = new URL(url).searchParams.get('state') ?? '';
    expect(state).not.toContain(nonce ?? '-');
    expect(verifyState(stateKey(), state, 'github-setup', nonce)).toMatchObject({ orgId: 'org-a', ref: 'app-1' });
    // No HTTP response to carry the cookie (REST / API key): the flow can't start.
    await expect(githubInstallLink({ ...orgCtx(db), resHeaders: undefined })).rejects.toThrow(
      'has to start in the dashboard',
    );
  });
});

describe('JIT credentials', () => {
  it('mints an installation token once and reuses it from memory', async () => {
    const { db, tables } = fakeDb();
    seedApp(tables);
    const { fn, calls } = fakeFetch({
      '/access_tokens': {
        token: 'ghs_install',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    setGitFetchForTests(fn);
    const conn = {
      id: 'c1',
      kind: 'GITHUB',
      status: 'active',
      installationId: '777',
      githubAppId: 'app-1',
      githubApp: tables.gitHubApp?.[0],
    };
    expect(await connectionCredentials(db, conn as never)).toEqual({
      token: 'ghs_install',
      tokenUser: 'x-access-token',
    });
    expect(await connectionCredentials(db, conn as never)).toEqual({
      token: 'ghs_install',
      tokenUser: 'x-access-token',
    });
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(1);
    expect(calls[0]?.headers.authorization?.startsWith('Bearer ey')).toBe(true); // App JWT, not a stored token
  });

  it('prefers a deploy key for ssh URLs, then the connection, then a legacy token', async () => {
    const { db } = fakeDb();
    const base = { connectionId: null, tokenEnc: null, deployKeyEnc: null, provider: 'GITLAB' };
    expect(
      await repoCredentials(db, {
        ...base,
        url: 'git@h:a/b.git',
        deployKeyEnc: encryptSecret('KEY'),
      }),
    ).toEqual({ sshKey: 'KEY' });
    expect(
      await repoCredentials(db, {
        ...base,
        url: 'https://gitlab.com/a/b',
        tokenEnc: encryptSecret('glpat'),
      }),
    ).toEqual({ token: 'glpat', tokenUser: 'oauth2' });
    expect(await repoCredentials(db, { ...base, url: 'https://x/y' })).toEqual({});
  });
});

describe('linkRepo', () => {
  it('generic ssh remote: mints a deploy key and returns the webhook once', async () => {
    const { db, tables } = fakeDb();
    const r = await linkRepo(orgCtx(db), {
      url: 'git@git.example.com:team/app.git',
      branch: 'main',
      configPath: './apps/web/swarmy.yaml',
    });
    expect(r.configPath).toBe('apps/web/swarmy.yaml');
    expect(r.deployKeyPublic).toMatch(/^ssh-ed25519 /);
    expect(r.webhook?.url).toBe(`https://swarmy.test/webhooks/git/${r.id}`);
    const row = tables.gitRepo?.[0] ?? {};
    expect(row.provider).toBe('GENERIC');
    expect(String(row.deployKeyEnc)).not.toContain('OPENSSH'); // vaulted, not plaintext
  });
});

describe('inspectCommit', () => {
  it('dispatches a runOnce with the token in env only, and parses the result', async () => {
    const { db, tables } = fakeDb();
    tables.node?.push({ id: 'n1', name: 'builder', orgId: 'org-a' });
    tables.gitRepo?.push({
      id: 'r1',
      orgId: 'org-a',
      url: 'https://gitlab.com/a/b.git',
      branch: 'main',
      configPath: 'swarmy.yaml',
      provider: 'GITLAB',
      tokenEnc: encryptSecret('glpat-SECRET'),
      connectionId: null,
      deployKeyEnc: null,
    });
    let sent: { image: string; cmd: string[]; env: Record<string, string> } | undefined;
    const h = hub((async (_node: string, _cmd: string, payload: unknown) => {
      sent = payload as typeof sent;
      const sha = 'd'.repeat(40);
      return {
        exitCode: 0,
        timedOut: false,
        output: `SWARMY_BEGIN\nSWARMY_HEAD ${sha}\nSWARMY_TREE\tswarmy.yaml\nSWARMY_FILE\tswarmy.yaml\t${Buffer.from('version: 1').toString('base64')}\nSWARMY_END\n`,
      };
    }) as never);
    const res = await inspectCommit(orgCtx(db, h), { repoId: 'r1' });
    expect(res.files['swarmy.yaml']).toBe('version: 1');
    expect(res.configPaths).toEqual(['swarmy.yaml']);
    expect(sent?.env).toEqual({
      GIT_URL: 'https://gitlab.com/a/b.git',
      GIT_TOKEN: 'glpat-SECRET',
      GIT_USER: 'oauth2',
    });
    expect(sent?.cmd.join(' ')).not.toContain('glpat-SECRET');
    // The push path never pays for the wizard's source scan.
    expect(sent?.cmd.join(' ')).not.toContain('SWARMY_SCANNED');
    expect(res.found).toBeUndefined();
  });

  it('scan: true greps the app folder and returns what it needs, timed', async () => {
    const { db, tables } = fakeDb();
    tables.node?.push({ id: 'n1', name: 'builder', orgId: 'org-a' });
    tables.gitRepo?.push({
      id: 'r2',
      orgId: 'org-a',
      url: 'https://github.com/northwind/platform.git',
      branch: 'main',
      configPath: 'services/orders/swarmy.yaml',
      provider: 'GITHUB',
      tokenEnc: null,
      connectionId: null,
      deployKeyEnc: null,
    });
    let cmd = '';
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const h = hub((async (_node: string, _cmd: string, payload: unknown) => {
      cmd = (payload as { cmd: string[] }).cmd.join(' ');
      return {
        exitCode: 0,
        timedOut: false,
        output: [
          'SWARMY_BEGIN',
          `SWARMY_HEAD ${'e'.repeat(40)}`,
          'SWARMY_NOFILE\tservices/orders/swarmy.yaml',
          `SWARMY_PROBE\tservices/orders/package.json\t${b64('{"dependencies": {"pg": "8"}}')}`,
          'SWARMY_SCANNED\tservices/orders/src/db.ts',
          'SWARMY_HIT\tservices/orders/src/db.ts\t4\tconst pool = new Pool({ connectionString: process.env.DATABASE_URL });',
          'SWARMY_END',
        ].join('\n'),
      };
    }) as never);
    const res = await inspectCommit(orgCtx(db, h), { repoId: 'r2', scan: true });
    expect(cmd).toContain("git ls-tree -r --name-only \"$H\" -- 'services/orders'");
    expect(cmd).toContain('services/orders/.env.example');
    expect(res.found).toMatchObject({ dir: 'services/orders', app: 'orders', files: 2, ms: expect.any(Number) });
    expect(res.found?.detections.find((d) => d.id === 'postgres')?.evidence).toEqual([
      { file: 'services/orders/package.json', line: 1, text: '{"dependencies": {"pg": "8"}}' },
      { file: 'services/orders/src/db.ts', line: 4, text: 'const pool = new Pool({ connectionString: process.env.DATABASE_URL });' },
    ]);
  });
});

describe('feedback', () => {
  it('only reports on a real sha and never throws', async () => {
    const { db } = fakeDb();
    const repo = {
      id: 'r',
      url: 'https://github.com/a/b',
      provider: 'GITHUB',
      connectionId: 'missing',
      fullName: 'a/b',
      externalRepoId: '1',
    };
    expect(
      await reportCommitStatus(db, repo, {
        sha: 'main',
        state: 'running',
        context: 'swarmy / build',
        description: 'x',
      }),
    ).toBe(false);
    expect(
      await reportCommitStatus(db, repo, {
        sha: 'a'.repeat(40),
        state: 'running',
        context: 'swarmy / build',
        description: 'x',
      }),
    ).toBe(false);
  });

  it('renders the preview comment (golden)', () => {
    expect(
      previewCommentBody({
        stack: 'pr42-orders',
        url: 'https://pr-42.preview.northwind.dev',
        sha: 'abcdef1234',
        state: 'deployed',
      }),
    ).toBe(
      [
        '### swarmy preview',
        '',
        'Live at **https://pr-42.preview.northwind.dev**',
        '',
        'Stack `pr42-orders` · commit `abcdef1`. Updates on every push; torn down when the PR closes.',
      ].join('\n'),
    );
    expect(previewCommentBody({ stack: 's', url: null, sha: null, state: 'torn-down' })).toBe(
      '### swarmy preview\n\nPreview `s` was torn down.',
    );
  });
});
