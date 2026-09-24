import { beforeEach, describe, expect, test } from 'bun:test';
import type { OrgContext } from '../context';
import {
  __resetDeviceAuthorizations,
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  describeDeviceAuthorization,
  DEVICE_CODE_TTL_MS,
  normalizeScopes,
  normalizeUserCode,
  pollDeviceAuthorization,
  startDeviceAuthorization,
} from './cli-device.service';
import { apiScopesFromOAuth } from '../apiKeyContext';

function ctxAs(role: 'owner' | 'admin' | 'member') {
  const created: Array<{ scopes: unknown; name: string }> = [];
  const audits: string[] = [];
  const ctx = {
    activeOrgId: 'org_1',
    user: { id: 'u1', email: 'a@b.c', name: 'A' },
    membership: { role, orgId: 'org_1' },
    db: {
      apiKey: {
        create: async ({ data }: { data: { name: string; scopes: unknown } }) => {
          created.push(data);
          return { id: 'key_1', name: data.name, prefix: 'abcd1234', scopes: data.scopes, lastUsedAt: null, createdAt: new Date(), createdById: 'u1', revokedAt: null };
        },
      },
      auditLog: { create: async ({ data }: { data: { action: string } }) => void audits.push(data.action) },
    },
  } as unknown as OrgContext;
  return { ctx, created, audits };
}

beforeEach(() => __resetDeviceAuthorizations());

describe('CLI device login', () => {
  test('codes are well formed; scopes normalised with read always in', () => {
    const d = startDeviceAuthorization({ scopes: ['write', 'bogus'] });
    expect(d.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(d.deviceCode.length).toBeGreaterThan(30);
    expect(normalizeScopes(['secrets.read'])).toEqual(['read', 'secrets.read']);
    expect(normalizeUserCode('bcdf ghjk')).toBe('BCDF-GHJK');
  });

  test('pending → approved hands out the key exactly once', async () => {
    const d = startDeviceAuthorization({ hostname: 'laptop', scopes: ['read', 'write'] });
    expect(pollDeviceAuthorization(d.deviceCode, 1_000).status).toBe('authorization_pending');
    expect(pollDeviceAuthorization(d.deviceCode, 1_500).status).toBe('slow_down');
    const { ctx, created, audits } = ctxAs('admin');
    expect(describeDeviceAuthorization(ctx, d.userCode.toLowerCase())).toMatchObject({ hostname: 'laptop', requestedScopes: ['read', 'write'] });
    const r = await approveDeviceAuthorization(ctx, { userCode: d.userCode });
    expect(r.scopes).toEqual(['read', 'write']);
    expect(created[0]).toMatchObject({ name: 'CLI · laptop', scopes: ['read', 'write'] });
    expect(audits).toEqual(['apiKey.create', 'cli.login.approve']);
    const p = pollDeviceAuthorization(d.deviceCode);
    expect(p).toMatchObject({ status: 'approved', scopes: ['read', 'write'] });
    expect((p as { key: string }).key).toMatch(/^swk_/);
    expect(pollDeviceAuthorization(d.deviceCode).status).toBe('expired_token');
  });

  test('a member may grant read only', async () => {
    const d = startDeviceAuthorization({ scopes: ['read', 'write'] });
    const { ctx } = ctxAs('member');
    await expect(approveDeviceAuthorization(ctx, { userCode: d.userCode })).rejects.toThrow('admin or owner');
    const r = await approveDeviceAuthorization(ctx, { userCode: d.userCode, scopes: ['read'] });
    expect(r.scopes).toEqual(['read']);
  });

  test('cannot grant more than was requested', async () => {
    const d = startDeviceAuthorization({ scopes: ['read'] });
    const r = await approveDeviceAuthorization(ctxAs('owner').ctx, { userCode: d.userCode, scopes: ['read', 'write', 'secrets.read'] });
    expect(r.scopes).toEqual(['read']);
  });

  test('deny and expiry', async () => {
    const a = startDeviceAuthorization({});
    await denyDeviceAuthorization(ctxAs('admin').ctx, a.userCode);
    expect(pollDeviceAuthorization(a.deviceCode).status).toBe('access_denied');
    const b = startDeviceAuthorization({});
    expect(pollDeviceAuthorization(b.deviceCode, Date.now() + DEVICE_CODE_TTL_MS + 1).status).toBe('expired_token');
    expect(pollDeviceAuthorization('nope').status).toBe('expired_token');
  });

  test('OAuth scopes map onto API scopes', () => {
    expect(apiScopesFromOAuth(['openid', 'swarmy:write'])).toEqual(['read', 'write']);
    expect(apiScopesFromOAuth(['swarmy:read'])).toEqual(['read']);
    expect(apiScopesFromOAuth(['openid', 'groups'])).toEqual([]);
  });
});
