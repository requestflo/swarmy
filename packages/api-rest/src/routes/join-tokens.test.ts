import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { useMemoryKv, type OrgContext } from '@swarmy/trpc';
import type { ApiKeyScope } from '@swarmy/core';
import { createRestApp } from '../app';
import { JoinTokenDto, JoinTokenIssuedDto } from '../dto-extra';

/**
 * /join-tokens rides token.service with the tRPC guards: list = any member,
 * create = admin (the plaintext once, only its hash stored), revoke = the
 * `token.revoke` policy step. The org runs no mesh here (the memory KV holds
 * no mesh config), so nothing reaches a mesh control plane.
 */

type Role = 'owner' | 'admin' | 'member';

interface Row {
  id: string;
  orgId: string;
  tokenHash: string;
  tokenPrefix: string;
  label: string | null;
  profile: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdById: string;
}

function appFor(opts: { role?: Role; scopes?: ApiKeyScope[]; stackNames?: string[] | null } = {}) {
  const role = opts.role ?? 'admin';
  const audit: string[] = [];
  const rows: Row[] = [
    {
      id: 'jt-old',
      orgId: 'org1',
      tokenHash: 'h',
      tokenPrefix: 'aa11bb22',
      label: 'edge boxes',
      profile: 'edge',
      maxUses: 3,
      uses: 3,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      revokedAt: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      createdById: 'user1',
    },
  ];
  const db = new Proxy(
    {
      member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
      policy: { findMany: async () => [] },
      resourceGrant: { findMany: async () => [] },
      joinToken: {
        create: async ({ data }: { data: Omit<Row, 'id' | 'uses' | 'revokedAt' | 'createdAt'> }) => {
          const row: Row = { ...data, id: `jt${rows.length}`, uses: 0, revokedAt: null, createdAt: new Date() };
          rows.push(row);
          return row;
        },
        findMany: async ({ where }: { where: { orgId: string } }) => rows.filter((r) => r.orgId === where.orgId),
        findFirst: async ({ where }: { where: { id: string; orgId: string } }) =>
          rows.find((r) => r.id === where.id && r.orgId === where.orgId) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      },
      auditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          audit.push(data.action);
          return {};
        },
      },
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        k in t ? t[k] : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
    },
  );
  const hub = new Proxy({ liveInventory: () => ({ services: [], containers: [] }) } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : () => { throw new Error(`unmocked hub.${k}`); }),
  });
  useMemoryKv(hub as never);
  const ctx = {
    db,
    hub,
    user: { id: 'user1' },
    activeOrgId: 'org1',
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  const app = createRestApp({
    resolveContextFromApiKey: async () => ({
      ctx,
      apiKey: { id: 'k1', scopes: opts.scopes ?? ['write'], stackNames: opts.stackNames ?? null },
    }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { call, rows, audit };
}

describe('POST /join-tokens', () => {
  it('mints a token for an admin: the plaintext once, only its hash stored', async () => {
    const t = appFor();
    const r = await t.call('POST', '/join-tokens', { label: 'ci', ttl_seconds: 600, max_uses: 2, profile: 'storage' });
    expect(r.status).toBe(201);
    expect(JoinTokenIssuedDto.safeParse(r.json).success).toBe(true);
    const token = r.json.token as string;
    expect(token).toMatch(/^swt_[0-9a-f]{8}_/);
    expect(r.json).toMatchObject({ id: 'jt1', label: 'ci', profile: 'storage', max_uses: 2, mesh: null });
    expect((r.json.install as { url: string }).url).toMatch(/^https?:\/\//);
    const stored = t.rows[1]!;
    expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(stored.tokenPrefix).toBe(token.split('_')[1]!);
    expect(stored.expiresAt!.getTime() - Date.now()).toBeGreaterThan(590_000);
  });

  it('`default` is no profile', async () => {
    const t = appFor();
    const r = await t.call('POST', '/join-tokens', { profile: 'default' });
    expect(r.status).toBe(201);
    expect(r.json.profile).toBeNull();
    expect(t.rows[1]!.profile).toBeNull();
  });

  it('refuses a member key (adminProcedure twin) and a read-only key', async () => {
    for (const t of [appFor({ role: 'member' }), appFor({ scopes: ['read'] })]) {
      const r = await t.call('POST', '/join-tokens', {});
      expect(r.status).toBe(403);
      expect(r.json.swarmy_code).toBe('POLICY_DENIED');
      expect(t.rows).toHaveLength(1);
    }
  });

  it('validates the body', async () => {
    const t = appFor();
    expect((await t.call('POST', '/join-tokens', { ttl_seconds: 10 })).status).toBe(400);
    expect((await t.call('POST', '/join-tokens', { max_uses: 0 })).status).toBe(400);
  });
});

describe('GET /join-tokens', () => {
  it('lists for any member, never the token or its hash', async () => {
    const t = appFor({ role: 'member', scopes: ['read'] });
    const r = await t.call('GET', '/join-tokens');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      data: [
        {
          id: 'jt-old',
          label: 'edge boxes',
          profile: 'edge',
          token_prefix: 'aa11bb22',
          created_at: '2026-10-01T00:00:00.000Z',
          expires_at: '2099-01-01T00:00:00.000Z',
          max_uses: 3,
          used_count: 3,
          revoked_at: null,
          status: 'exhausted',
        },
      ],
      next_cursor: null,
    });
    expect(JoinTokenDto.safeParse((r.json.data as unknown[])[0]).success).toBe(true);
  });

  it('is org-wide: an app-scoped key is refused', async () => {
    const t = appFor({ stackNames: ['shop'] });
    expect((await t.call('GET', '/join-tokens')).status).toBe(403);
  });
});

describe('DELETE /join-tokens/{id}', () => {
  it('revokes through the token.revoke policy step', async () => {
    const t = appFor();
    const r = await t.call('DELETE', '/join-tokens/jt-old');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: 'jt-old', revoked: true });
    expect(t.rows[0]!.revokedAt).toBeInstanceOf(Date);
    expect(t.audit).toEqual(['authz.permit:token.revoke']);
    const list = await t.call('GET', '/join-tokens');
    expect((list.json.data as { status: string }[])[0]!.status).toBe('revoked');
  });

  it('a member is refused (owner/admin only by default)', async () => {
    const t = appFor({ role: 'member' });
    const r = await t.call('DELETE', '/join-tokens/jt-old');
    expect(r.status).toBe(403);
    expect(t.audit).toEqual(['authz.deny:token.revoke']);
    expect(t.rows[0]!.revokedAt).toBeNull();
  });

  it('another org’s or an unknown token is 404', async () => {
    const t = appFor();
    expect((await t.call('DELETE', '/join-tokens/nope')).status).toBe(404);
  });
});
