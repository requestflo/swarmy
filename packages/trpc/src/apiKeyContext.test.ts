import { describe, expect, it } from 'bun:test';
import { hashToken } from '@swarmy/core/crypto';
import { resolveOrgContextFromApiKey } from './apiKeyContext';
import { createApiKey } from './services/apiKeys.service';
import type { OrgContext } from './context';

/** One stored key row; the resolver looks it up by hash. */
function depsWith(row: Record<string, unknown> | null) {
  const db = {
    apiKey: {
      findUnique: async ({ where }: { where: { keyHash: string } }) =>
        row && row.keyHash === where.keyHash ? row : null,
      update: async () => ({}),
    },
    member: { findFirst: async () => ({ role: 'admin', organizationId: 'org1' }) },
    user: { findUnique: async () => ({ id: 'u1', email: 'a@b.c', name: 'A' }) },
  };
  return { db, hub: {}, auth: {} } as never;
}

const KEY = 'swk_ab12cd34_secret';
const base = {
  id: 'k1',
  orgId: 'org1',
  keyHash: hashToken(KEY),
  scopes: ['read', 'deploy'],
  stackNames: ['shop'],
  revokedAt: null,
  expiresAt: null,
  createdById: 'u1',
};

describe('resolveOrgContextFromApiKey', () => {
  it('resolves a live key with its scopes and app list', async () => {
    const r = await resolveOrgContextFromApiKey(depsWith(base), `Bearer ${KEY}`);
    expect(r?.apiKey).toEqual({ id: 'k1', scopes: ['read', 'deploy'], kind: 'api_key', stackNames: ['shop'] });
    expect(r?.ctx.activeOrgId).toBe('org1');
  });

  it('an expired key is rejected (401 upstream)', async () => {
    const r = await resolveOrgContextFromApiKey(depsWith({ ...base, expiresAt: new Date(Date.now() - 1000) }), KEY);
    expect(r).toBeNull();
  });

  it('a key that expires later still works; a revoked one does not', async () => {
    expect(await resolveOrgContextFromApiKey(depsWith({ ...base, expiresAt: new Date(Date.now() + 60_000) }), KEY)).not.toBeNull();
    expect(await resolveOrgContextFromApiKey(depsWith({ ...base, revokedAt: new Date() }), KEY)).toBeNull();
  });

  it('a key with no app list reaches every app (stackNames null)', async () => {
    const r = await resolveOrgContextFromApiKey(depsWith({ ...base, stackNames: null }), KEY);
    expect(r?.apiKey.stackNames).toBeNull();
  });
});

describe('createApiKey', () => {
  function ctxCapturing(out: { data?: Record<string, unknown>; audit?: Record<string, unknown> }): OrgContext {
    return {
      activeOrgId: 'org1',
      user: { id: 'u1' },
      db: {
        apiKey: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            out.data = data;
            return { id: 'k1', createdAt: new Date(), lastUsedAt: null, revokedAt: null, stackNames: null, ...data };
          },
        },
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            out.audit = data;
            return {};
          },
        },
      },
    } as unknown as OrgContext;
  }

  it('a preset sets the real scopes; apps and expiry are stored; the plaintext comes back once', async () => {
    const out: { data?: Record<string, unknown>; audit?: Record<string, unknown> } = {};
    const issued = await createApiKey(ctxCapturing(out), {
      name: 'ci',
      preset: 'deploy',
      stackNames: ['shop', 'shop'],
      expiry: '90d',
    });
    expect(out.data?.scopes).toEqual(['read', 'deploy']);
    expect(out.data?.stackNames).toEqual(['shop']);
    const days = ((out.data?.expiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    expect(issued.key.startsWith('swk_')).toBe(true);
    expect(out.data?.keyHash).toBe(hashToken(issued.key));
    expect(issued.preset).toBe('deploy');
    expect(issued.stackNames).toEqual(['shop']);
    expect(out.audit?.action).toBe('apiKey.create');
  });

  it('refuses an empty app list (use null for every app)', async () => {
    await expect(createApiKey(ctxCapturing({}), { name: 'x', stackNames: [] })).rejects.toThrow(/at least one app/);
  });
});
