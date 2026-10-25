/**
 * Test-only: the REST app over an in-memory db, for route tests. The caller
 * passes the Prisma delegates its routes touch; the member/policy/grant reads
 * the auth + policy steps make, the audit writer and the Idempotency-Key store
 * are filled in. Any other delegate throws, so a route reaching for data it
 * shouldn't fails loudly. No Docker, no database.
 */
import type { ApiKeyScope } from '@swarmy/core';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from './app';

export type Role = 'owner' | 'admin' | 'member';

export interface TestAppOptions {
  role?: Role;
  scopes?: ApiKeyScope[];
  stackNames?: string[] | null;
  models?: Record<string, unknown>;
  hub?: Record<string, unknown>;
}

export function testApp(opts: TestAppOptions = {}) {
  const role = opts.role ?? 'admin';
  const audit: Array<{ action: string; metadata?: unknown }> = [];
  const idem: Array<Record<string, unknown>> = [];
  const base: Record<string, unknown> = {
    member: { findFirst: async () => ({ id: 'mem1', role, organizationId: 'org1', attributes: {} }) },
    policy: { findMany: async () => [] },
    resourceGrant: { findMany: async () => [] },
    auditLog: {
      create: async ({ data }: { data: { action: string; metadata?: unknown } }) => {
        audit.push({ action: data.action, metadata: data.metadata });
        return {};
      },
    },
    idempotencyKey: {
      findUnique: async ({ where }: { where: { orgId_key: { orgId: string; key: string } } }) =>
        idem.find((r) => r.orgId === where.orgId_key.orgId && r.key === where.orgId_key.key) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        idem.push(data);
        return data;
      },
    },
    ...opts.models,
  };
  const db = new Proxy(base, {
    get: (t, k: string) =>
      k in t ? t[k] : new Proxy({}, { get: () => async () => { throw new Error(`unmocked db.${k}`); } }),
  });
  const hub = new Proxy(opts.hub ?? {}, {
    get: (t, k: string) => (k in t ? t[k] : () => { throw new Error(`unmocked hub.${k}`); }),
  });
  const ctx = {
    db,
    hub,
    user: { id: 'user1', name: 'Ada', email: 'ada@example.com' },
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
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: 'Bearer swk_test_x',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as Record<string, any> };
  };
  return { call, audit, actions: () => audit.map((a) => a.action) };
}
