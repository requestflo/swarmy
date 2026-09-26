import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from '../app';
import type { ApiKeyScope } from '../deps';

/** Gates of the developer-loop routes (the CLI + MCP server's REST surface). */

function appFor(role: 'owner' | 'admin' | 'member', scopes: ApiKeyScope[], kind: 'api_key' | 'oauth' = 'api_key') {
  const db = new Proxy({} as Record<string, unknown>, {
    get: () => new Proxy({}, { get: () => async () => { throw new Error('reached the service layer'); } }),
  });
  const hub = new Proxy({}, { get: () => () => { throw new Error('reached the hub'); } });
  const ctx = {
    db,
    hub,
    user: { id: 'user1', email: 'dev@acme.test', name: 'Dev' },
    activeOrgId: 'org1',
    membership: { role, orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
  return createRestApp({ resolveContextFromApiKey: async () => ({ ctx, apiKey: { id: kind === 'oauth' ? 'oauth:swarmy-mcp' : 'k1', scopes, kind } }) });
}

const call = (app: ReturnType<typeof appFor>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer swk_test' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe('developer routes', () => {
  it('GET /me reports the principal and the credential', async () => {
    const res = await call(appFor('member', ['read'], 'oauth'), 'GET', '/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      org_id: 'org1',
      user: { id: 'user1', email: 'dev@acme.test', name: 'Dev' },
      role: 'member',
      credential: { kind: 'oauth', id: 'oauth:swarmy-mcp', scopes: ['read'] },
    });
  });

  // Ship-shaped routes need `deploy` (a write key has it; a read key doesn't).
  for (const [method, path, body] of [
    ['PATCH', '/services/s1/env', { set: { A: '1' } }],
    ['POST', '/apps/r1/previews', { branch: 'feat/x' }],
  ] as const) {
    it(`${method} ${path} needs the deploy scope`, async () => {
      const res = await call(appFor('owner', ['read', 'secrets.read']), method, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { detail: string }).detail).toContain('"deploy" scope');
    });
  }

  const WRITES: Array<[string, string, unknown]> = [
    ['PUT', '/stacks/shop/telemetry', { enabled: true }],
    ['POST', '/stacks/shop/errors/rotate-key', {}],
  ];
  for (const [method, path, body] of WRITES) {
    it(`${method} ${path} needs the write scope`, async () => {
      const res = await call(appFor('owner', ['read', 'secrets.read']), method, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { detail: string }).detail).toContain('"write" scope');
    });
  }

  for (const [method, path, body] of [
    ['PUT', '/stacks/shop/telemetry', { enabled: true }],
    ['POST', '/stacks/shop/errors/rotate-key', {}],
  ] as const) {
    it(`${method} ${path} is admin-only (adminProcedure twin)`, async () => {
      const res = await call(appFor('member', ['write']), method, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { swarmy_code: string }).swarmy_code).toBe('POLICY_DENIED');
    });
  }

  it('the spec documents the SSE stream', async () => {
    const doc = (await (await appFor('owner', ['read']).request('/openapi.json')).json()) as {
      paths: Record<string, { get?: { responses: Record<string, { content?: Record<string, unknown> }> } }>;
    };
    expect(Object.keys(doc.paths['/services/{id}/logs/stream']!.get!.responses['200']!.content!)).toEqual(['text/event-stream']);
  });
});
