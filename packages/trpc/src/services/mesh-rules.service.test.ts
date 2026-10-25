import { afterEach, describe, expect, test } from 'bun:test';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { seedKv, useMemoryKv } from './swarm-kv.service';

process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-mesh-rules-0123456789abcdef';
const { encryptSecret } = await import('@swarmy/core/crypto');
const { addAccessRule, listAccessRules, removeAccessRule } = await import('./mesh-rules.service');

const GROUPS = [
  { id: 'g-nodes', name: 'swarmy:lon:nodes' },
  { id: 'g-srv', name: 'Servers' },
  { id: 'g-db', name: 'Databases' },
];
const NODES = { id: 'p-nodes', name: 'swarmy-lon-nodes', enabled: true, rules: [{ name: 'n', enabled: true, action: 'accept', bidirectional: true, protocol: 'all', sources: ['g-nodes'], destinations: ['g-nodes'] }] };

/** A NetBird that answers groups + policies, recording what swarmy sent. */
function netbird() {
  const policies: Record<string, unknown>[] = [structuredClone(NODES)];
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    sent.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/groups') return Response.json(GROUPS);
    if (url.pathname === '/api/policies' && method === 'GET') return Response.json(policies);
    if (url.pathname === '/api/policies' && method === 'POST') {
      const p = { ...JSON.parse(String(init?.body)), id: 'p-new' };
      policies.push(p);
      return Response.json(p);
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

function ctxWith(mesh: Record<string, unknown>, audit: { action: string; metadata: unknown }[] = []): OrgContext {
  const hub = {} as unknown as AgentHub;
  useMemoryKv(hub);
  seedKv(hub, 'org1', 'mesh', 'org1', mesh);
  const db = { auditLog: { create: async ({ data }: { data: { action: string; metadata: unknown } }) => (audit.push({ action: data.action, metadata: data.metadata }), {}) } };
  return { hub, db, activeOrgId: 'org1', user: { id: 'u1' } } as unknown as OrgContext;
}

const external = () => ({
  driver: 'NETBIRD',
  enabled: true,
  managementUrl: 'https://nb.example.com',
  controlPlane: { mode: 'external', url: 'https://nb.example.com', serviceTokenEnc: encryptSecret('nbp_token') },
  settings: {},
});

let nb: ReturnType<typeof netbird> | null = null;
afterEach(() => nb?.restore());

describe('mesh access rules on Mesh settings', () => {
  test('NetBird: every rule in plain words, read live from its policies', async () => {
    nb = netbird();
    const v = await listAccessRules(ctxWith(external()));
    expect(v).toMatchObject({ supported: true, note: null, error: null, groups: ['Databases', 'Servers'] });
    expect(v.rules.map((r) => [r.words, r.managedBySwarmy])).toEqual([['Servers can reach each other on every port', true]]);
  });

  test('adding a rule creates one NetBird policy and an audit row; swarmy\'s own rule is never removed', async () => {
    nb = netbird();
    const audit: { action: string; metadata: unknown }[] = [];
    const ctx = ctxWith(external(), audit);
    const v = await addAccessRule(ctx, { from: 'Servers', to: 'Databases', protocol: 'tcp', ports: [5432] });
    expect(v.rules.map((r) => r.words)).toEqual(['Servers can reach each other on every port', 'Servers can reach Databases on 5432']);
    expect(nb.sent).toContain('POST /api/policies');
    expect(audit.map((a) => a.action)).toEqual(['mesh.rule.add']);
    expect(audit[0]!.metadata).toMatchObject({ name: 'Servers → Databases tcp/5432', words: 'Servers can reach Databases on 5432' });
    await expect(removeAccessRule(ctx, 'p-nodes')).rejects.toThrow("swarmy-lon-nodes is swarmy's own rule");
    await expect(addAccessRule(ctx, { from: 'swarmy:lon:nodes', to: 'Databases', protocol: 'tcp', ports: [22] })).rejects.toThrow("isn't a group you can use");
    expect(nb.sent.filter((s) => s.startsWith('DELETE'))).toEqual([]);
  });

  test('Headscale has no rules swarmy can read yet; a mesh that is off has none', async () => {
    const hs = await listAccessRules(ctxWith({ ...external(), driver: 'HEADSCALE' }));
    expect(hs).toEqual({ supported: false, note: "Headscale keeps its rules in its own policy file; swarmy doesn't list them yet.", rules: [], groups: [], error: null });
    await expect(addAccessRule(ctxWith({ ...external(), driver: 'HEADSCALE' }), { from: 'a', to: 'b', protocol: 'tcp', ports: [] })).rejects.toThrow('Headscale keeps its rules');
    expect((await listAccessRules(ctxWith({ ...external(), enabled: false }))).note).toBe('The private network is off, so there are no rules yet.');
  });

  test('a control plane that does not answer is an error line, not a crash', async () => {
    nb = netbird();
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const v = await listAccessRules(ctxWith(external()));
    expect(v.supported).toBe(true);
    expect(v.error).toContain("Couldn't read the rules from the control plane");
  });
});
