import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type DB, type TestDb } from '@swarmy/db';
import { buildAuth } from './server';
import { cookieJar, totpFromUri } from './totp-testing';

// "Members sign in with SSO only" through the real Better Auth hooks and the
// real migrations: the refusal happens before any session exists, and an
// owner's password + 2FA break-glass gets in and is audited.

const BASE = 'http://localhost:3021';
const ENV = ['BETTER_AUTH_URL', 'SWARMY_ALLOW_SIGNUP', 'SWARMY_AUTH_RATE_LIMIT'] as const;
const PASSWORD = 'correct-horse-battery';

describe('SSO-only org: sign-in through the auth hooks', () => {
  let store: TestDb;
  let db: DB;
  let auth: ReturnType<typeof buildAuth>;
  const audits: Array<{ orgId: string; action: string; metadata?: Record<string, unknown> }> = [];
  const saved = ENV.map((k) => process.env[k]);
  const ids: Record<string, string> = {};
  let totpURI = '';

  async function person(name: string, role: string, orgs: string[]): Promise<string> {
    const up = await auth.api.signUpEmail({ body: { email: `${name}@acme.test`, password: PASSWORD, name } });
    for (const org of orgs) await db.member.create({ data: { id: `m-${name}-${org}`, organizationId: org, userId: up.user.id, role } });
    return (ids[name] = up.user.id);
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-000';
    Object.assign(process.env, { BETTER_AUTH_URL: BASE, SWARMY_ALLOW_SIGNUP: 'true', SWARMY_AUTH_RATE_LIMIT: '0' });
    store = await createTestDb();
    db = store.db;
    auth = buildAuth({ social: {} }, { db, audit: async (orgId, e) => void audits.push({ orgId, ...e }) });
    await db.organization.create({ data: { id: 'org-a', name: 'Acme', slug: 'acme' } });
    await db.organization.create({ data: { id: 'org-b', name: 'Side', slug: 'side' } });
    await person('owner', 'owner', ['org-a']);
    await person('bare-owner', 'owner', ['org-a']);
    await person('dev', 'member', ['org-a']);
    await person('both', 'member', ['org-a', 'org-b']);
    // The owner enrols an authenticator before the switch goes on.
    const cookie = cookieJar('', (await auth.api.signInEmail({ body: { email: 'owner@acme.test', password: PASSWORD }, returnHeaders: true })).headers);
    totpURI = (await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: new Headers({ cookie }) })).totpURI;
    await auth.api.verifyTOTP({ body: { code: totpFromUri(totpURI) }, headers: new Headers({ cookie }) });
    await db.session.deleteMany({});
    await db.orgSecurityPolicy.create({ data: { orgId: 'org-a', requireSso: true } });
  }, 60_000);

  afterAll(async () => {
    await store.close();
    ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  const signIn = (email: string, cookie = '') =>
    auth.handler(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
  const sessionsOf = (name: string) => db.session.findMany({ where: { userId: ids[name] } });

  it('refuses a member’s password sign-in before any session exists, and audits it', async () => {
    const res = await signIn('dev@acme.test');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'SSO_REQUIRED' });
    expect(await sessionsOf('dev')).toHaveLength(0);
    expect(audits).toContainEqual(expect.objectContaining({ orgId: 'org-a', action: 'auth.signIn.ssoRequired' }));
  });

  it('refuses an owner’s password sign-in without two-factor', async () => {
    const res = await signIn('bare-owner@acme.test');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'BREAK_GLASS_NEEDS_2FA' });
    expect(await sessionsOf('bare-owner')).toHaveLength(0);
  });

  it('lands a member of two orgs in the one that allows passwords, and refuses the switch', async () => {
    const res = await signIn('both@acme.test');
    expect(res.status).toBe(200);
    const [s] = await sessionsOf('both');
    expect(s).toMatchObject({ activeOrganizationId: 'org-b', signInMethod: 'password' });
    const headers = new Headers({ cookie: cookieJar('', res.headers) });
    await expect(auth.api.setActiveOrganization({ body: { organizationId: 'org-a' }, headers })).rejects.toThrow(/SSO only/);
    expect((await sessionsOf('both'))[0]?.activeOrganizationId).toBe('org-b');
  });

  it('lets an owner in with password + 2FA (break-glass) and audits it', async () => {
    const step = await signIn('owner@acme.test');
    expect(await step.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionsOf('owner')).toHaveLength(0);
    const v = await auth.api.verifyTOTP({
      body: { code: totpFromUri(totpURI), trustDevice: true },
      headers: new Headers({ cookie: cookieJar('', step.headers) }),
      returnHeaders: true,
    });
    const [s] = await sessionsOf('owner');
    expect(s).toMatchObject({ activeOrganizationId: 'org-a', signInMethod: 'password_2fa', mfaPending: false });
    expect(s?.mfaVerifiedAt).toBeInstanceOf(Date);
    expect(audits.at(-1)).toMatchObject({
      orgId: 'org-a',
      action: 'auth.breakGlass.signIn',
      metadata: { method: 'password_2fa', secondFactor: 'challenge' },
    });
    // A trusted device skips the plugin's challenge, never the break-glass code.
    const trusted = cookieJar('', v.headers);
    const again = await signIn('owner@acme.test', trusted);
    expect(await again.json()).not.toMatchObject({ twoFactorRedirect: true });
    const latest = (await sessionsOf('owner')).find((x) => x.id !== s?.id);
    expect(latest).toMatchObject({ signInMethod: 'password', mfaPending: true, mfaVerifiedAt: null });
    expect(audits.at(-1)).toMatchObject({ action: 'auth.breakGlass.signIn', metadata: { secondFactor: 'in-session' } });
  });
});
