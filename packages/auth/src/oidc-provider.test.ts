import { describe, expect, it } from 'bun:test';
import {
  buildIdentityClaims,
  hashOidcClientSecret,
  memberGroups,
  oidcIssuer,
  verifyOidcClientSecret,
} from './oidc-provider';
import {
  ensureNetbirdOidcClient,
  ensureOidcClient,
  NETBIRD_OIDC_CLIENT,
  NETBIRD_OIDC_CLIENT_ID,
  removeOidcClient,
  rotateOidcClientSecret,
  type OidcClientDb,
} from './oidc-clients';

describe('memberGroups', () => {
  it('unions groups, ssoGroups and teamIds, sorted and de-duplicated', () => {
    expect(memberGroups({ groups: ['ops', 'dev'], ssoGroups: ['dev', 'sre'], teamIds: ['t1'], other: 'x' })).toEqual([
      'dev',
      'ops',
      'sre',
      't1',
    ]);
    expect(memberGroups(null)).toEqual([]);
    expect(memberGroups({ groups: 'not-a-list', teamIds: [1, 'ok'] })).toEqual(['ok']);
  });
});

describe('buildIdentityClaims', () => {
  const membership = { orgId: 'org1', orgSlug: 'acme', role: 'member', attributes: { groups: ['app-shop'] } };

  it('carries groups, org and role, and a preferred username', () => {
    const c = buildIdentityClaims({ id: 'u1', email: 'ada@acme.io', name: 'Ada', username: 'ada' }, membership);
    expect(c).toMatchObject({ preferred_username: 'ada', groups: ['app-shop'], org: 'org1', org_slug: 'acme', role: 'member' });
    expect('email' in c).toBe(false); // the real email claim is left to the provider
  });

  it('blanks a placeholder email and falls back to the email local part', () => {
    const placeholder = buildIdentityClaims({ id: 'u2', email: 'bob@users.swarmy.invalid', username: 'bob' }, null);
    expect(placeholder.email).toBeUndefined();
    expect('email' in placeholder).toBe(true); // explicit undefined overrides the standard claim
    expect(placeholder.groups).toEqual([]);
    expect(buildIdentityClaims({ id: 'u3', email: 'cy@acme.io' }, null).preferred_username).toBe('cy');
  });
});

describe('client secrets + issuer', () => {
  it('hashes and verifies', () => {
    const h = hashOidcClientSecret('s3cret');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyOidcClientSecret('s3cret', h)).toBe(true);
    expect(verifyOidcClientSecret('nope', h)).toBe(false);
    expect(verifyOidcClientSecret('s3cret', 'short')).toBe(false);
  });
  it('issues from BETTER_AUTH_URL + /api/auth', () => {
    expect(oidcIssuer({ BETTER_AUTH_URL: 'https://swarmy.example.com/' })).toBe('https://swarmy.example.com/api/auth');
  });
});

function mockDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    oidcClient: {
      findUnique: async ({ where }: { where: { clientId: string } }) => rows.get(where.clientId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.set(data.clientId as string, { ...data });
        return data;
      },
      update: async ({ where, data }: { where: { clientId: string }; data: Record<string, unknown> }) => {
        const next = { ...rows.get(where.clientId)!, ...data };
        rows.set(where.clientId, next);
        return next;
      },
      deleteMany: async ({ where }: { where: { clientId: string } }) => ({ count: rows.delete(where.clientId) ? 1 : 0 }),
    },
  };
  return { rows, db: db as unknown as OidcClientDb };
}

describe('ensureOidcClient', () => {
  it('creates a confidential client once, returning the secret only then', async () => {
    const { rows, db } = mockDb();
    const input = { clientId: 'grafana', name: 'Grafana', type: 'confidential' as const, redirectUris: ['https://g.io/cb'] };
    const first = await ensureOidcClient(db, input);
    expect(first.created).toBe(true);
    expect(first.clientSecret).toBeTruthy();
    expect(rows.get('grafana')!.clientSecret).toBe(hashOidcClientSecret(first.clientSecret!));

    const again = await ensureOidcClient(db, { ...input, redirectUris: ['https://g.io/cb', 'https://g.io/cb2'] });
    expect(again.created).toBe(false);
    expect(again.clientSecret).toBeUndefined();
    expect(rows.get('grafana')!.clientSecret).toBe(hashOidcClientSecret(first.clientSecret!));
    expect(rows.get('grafana')!.redirectUris).toEqual(['https://g.io/cb', 'https://g.io/cb2']);

    const rotated = await rotateOidcClientSecret(db, 'grafana');
    expect(rotated.clientSecret).not.toBe(first.clientSecret);
    expect(await removeOidcClient(db, 'grafana')).toEqual({ removed: true });
    expect(await removeOidcClient(db, 'grafana')).toEqual({ removed: false });
  });

  it('refuses bad ids and redirect URIs', async () => {
    const { db } = mockDb();
    await expect(ensureOidcClient(db, { clientId: 'a b', name: 'x', type: 'public', redirectUris: ['https://x'] })).rejects.toThrow();
    await expect(ensureOidcClient(db, { clientId: 'abc', name: 'x', type: 'public', redirectUris: [] })).rejects.toThrow();
    await expect(
      ensureOidcClient(db, { clientId: 'abc', name: 'x', type: 'public', redirectUris: ['javascript:alert(1)'] }),
    ).rejects.toThrow();
  });
});

describe('NetBird preset', () => {
  it('is a public PKCE client with the dashboard and CLI loopback redirects', async () => {
    const preset = NETBIRD_OIDC_CLIENT('https://netbird.example.com/');
    expect(preset.redirectUris).toEqual([
      'https://netbird.example.com/nb-auth',
      'https://netbird.example.com/nb-silent-auth',
      'http://localhost:53000',
      'http://localhost:54000',
    ]);
    const { rows, db } = mockDb();
    const res = await ensureNetbirdOidcClient(db, { dashboardUrl: 'https://netbird.example.com' });
    expect(res.clientId).toBe(NETBIRD_OIDC_CLIENT_ID);
    expect(res.clientSecret).toBeUndefined();
    expect(res.audience).toBe(NETBIRD_OIDC_CLIENT_ID);
    const row = rows.get(NETBIRD_OIDC_CLIENT_ID)!;
    expect(row).toMatchObject({ public: true, requirePKCE: true, tokenEndpointAuthMethod: 'none', skipConsent: true });
    expect(row.scopes).toContain('groups');
  });
});
