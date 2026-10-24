import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { appRouter } from '../root';
import { completeGithubManifest } from '../services/git-connections.service';
import { setGitFetchForTests } from '../services/git-credentials';
import { bindHash, signState, verifyState } from '../services/git-providers';

/**
 * Security review (Low): the GitHub App is controller-wide — one per GitHub
 * host, and the first registration wins — so only the instance owner (the
 * owner of the controller's, i.e. oldest, org) may register it. Any org's
 * admin still installs it on their own accounts.
 */

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

type M = { organizationId: string; userId: string; role: string };
const MEMBERS: M[] = [
  { organizationId: 'org_ctrl', userId: 'root', role: 'owner' },
  { organizationId: 'org_ctrl', userId: 'adm', role: 'admin' },
  { organizationId: 'org_late', userId: 'eve', role: 'owner' },
];

function fakeDb() {
  const apps: Array<Record<string, unknown>> = [];
  const db = {
    organization: { findFirst: async () => ({ id: 'org_ctrl' }) },
    member: {
      findFirst: async ({ where }: { where: Partial<M> }) => {
        const m = MEMBERS.find((x) => Object.entries(where).every(([k, v]) => x[k as keyof M] === v));
        return m ? { id: 'm', role: m.role, organizationId: m.organizationId, createdAt: new Date(0), attributes: {} } : null;
      },
    },
    gitHubApp: {
      findFirst: async () => null,
      create: async (a: { data: Record<string, unknown> }) => {
        const row = { id: 'app-1', ...a.data };
        apps.push(row);
        return row;
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return { db, apps };
}

const caller = (userId: string, activeOrgId: string) =>
  appRouter.createCaller({
    db: fakeDb().db,
    hub: {},
    session: { id: 's1', token: 't1' },
    user: { id: userId, email: `${userId}@example.com`, name: userId },
    activeOrgId,
    reqHeaders: new Headers(),
    resHeaders: new Headers(),
  } as unknown as OrgContext);

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof TRPCError ? `${e.code}:${e.message}` : `other:${(e as Error).message}`;
  }
}

describe('gitConnections.startGithubManifest is instance-owner-only', () => {
  it('refuses an admin of the controller org and the owner of a later org', async () => {
    expect(await outcome(caller('adm', 'org_ctrl').gitConnections.startGithubManifest())).toStartWith('FORBIDDEN:Only the owner');
    expect(await outcome(caller('eve', 'org_late').gitConnections.startGithubManifest())).toStartWith('FORBIDDEN:Only the owner');
  });

  it('lets the instance owner build the manifest', async () => {
    const r = await caller('root', 'org_ctrl').gitConnections.startGithubManifest();
    expect(r.postUrl).toStartWith('https://github.com/settings/apps/new?state=');
  });
});

describe('the manifest callback re-checks the owner and keeps the browser binding', () => {
  const key = () =>
    createHmac('sha256', ENV.SWARMY_SECRET_KEY).update('swarmy:git-oauth-state:v1').digest('hex');
  const nonce = 'c'.repeat(64);
  const state = (userId: string) =>
    signState(key(), { purpose: 'github-manifest', orgId: 'org_ctrl', userId, ref: 'https://github.com', bind: bindHash(nonce) });
  const conversion = { id: 9, slug: 'swarmy-x', name: 'swarmy-x', html_url: 'h', client_id: 'c', client_secret: 's', webhook_secret: 'w', pem: 'p' };

  it('a state minted for someone who is not (or no longer) the instance owner registers nothing', async () => {
    const { db, apps } = fakeDb();
    let called = 0;
    setGitFetchForTests(async () => (called++, new Response(JSON.stringify(conversion))));
    const res = completeGithubManifest({ db, hub: {}, auth: {} } as never, { code: 'k', state: state('adm'), browserNonce: nonce });
    expect(await outcome(res)).toStartWith('FORBIDDEN:Only the owner');
    expect([called, apps.length]).toEqual([0, 0]);
  });

  it('the owner registers it, and the install step is bound to the same browser', async () => {
    const { db, apps } = fakeDb();
    setGitFetchForTests(async () => new Response(JSON.stringify(conversion)));
    const { installUrl } = await completeGithubManifest({ db, hub: {}, auth: {} } as never, {
      code: 'k',
      state: state('root'),
      browserNonce: nonce,
    });
    expect(apps).toHaveLength(1);
    const next = new URL(installUrl).searchParams.get('state') ?? '';
    expect(verifyState(key(), next, 'github-setup', nonce)).toMatchObject({ orgId: 'org_ctrl', ref: 'app-1' });
    expect(verifyState(key(), next, 'github-setup', 'd'.repeat(64))).toBeNull();
  });
});
