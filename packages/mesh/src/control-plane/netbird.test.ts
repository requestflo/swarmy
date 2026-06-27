import { describe, expect, test } from 'bun:test';
import { NetbirdControlPlane } from './netbird';
import { MeshControlPlaneError } from '../errors';
import { buildNetbirdPolicyPlan, principalTagForRoute, targetTagForRoute } from '../acl';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('NetbirdControlPlane construction', () => {
  test('fails fast without credentials', () => {
    expect(() => new NetbirdControlPlane({ managementUrl: 'https://x', serviceToken: '' })).toThrow(
      MeshControlPlaneError,
    );
    expect(() => new NetbirdControlPlane({ managementUrl: '', serviceToken: 't' })).toThrow(
      MeshControlPlaneError,
    );
  });
});

describe('NetbirdControlPlane.createSetupKey', () => {
  test('POSTs /api/setup-keys with the token and returns the key', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: 'sk1', key: 'NB_KEY_XYZ', name: 'swarmy-n1', expires: 'soon' });
    }) as unknown as typeof fetch;

    const cp = new NetbirdControlPlane({
      managementUrl: 'https://netbird.example.com/',
      serviceToken: 'tok',
      fetchImpl,
    });
    const { setupKey } = await cp.createSetupKey({ nodeId: 'n1' });
    expect(setupKey).toBe('NB_KEY_XYZ');
    expect(calls[0]!.url).toBe('https://netbird.example.com/api/setup-keys');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Token tok');
    expect(JSON.parse(String(calls[0]!.init!.body)).usage_limit).toBe(1);
  });
});

describe('NetbirdControlPlane.listPeers', () => {
  test('maps the /api/peers shape', async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        { id: 'p1', ip: '100.64.0.2', connected: true, last_seen: '2026-06-27T00:00:00Z', hostname: 'web-1' },
      ])) as unknown as typeof fetch;
    const cp = new NetbirdControlPlane({ managementUrl: 'https://x', serviceToken: 't', fetchImpl });
    const peers = await cp.listPeers();
    expect(peers).toEqual([
      { peerId: 'p1', nodeId: 'web-1', meshIp: '100.64.0.2', connected: true, lastSeen: '2026-06-27T00:00:00Z' },
    ]);
  });
});

describe('NetbirdControlPlane.applyPolicyPlan', () => {
  test('creates missing groups then posts policies', async () => {
    const created: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/api/groups') && method === 'GET') {
        return jsonResponse([{ id: 'g-existing', name: 'tag:dc-route_a' }]);
      }
      if (u.endsWith('/api/groups') && method === 'POST') {
        const name = JSON.parse(String(init!.body)).name;
        created.push(name);
        return jsonResponse({ id: `g-${name}`, name });
      }
      if (u.endsWith('/api/policies') && method === 'POST') {
        return jsonResponse({ id: 'pol-1' });
      }
      throw new Error(`unexpected ${method} ${u}`);
    }) as unknown as typeof fetch;

    const cp = new NetbirdControlPlane({ managementUrl: 'https://x', serviceToken: 't', fetchImpl });
    const plan = buildNetbirdPolicyPlan({
      orgId: 'o',
      grants: [
        {
          id: 'route_a',
          principalTag: principalTagForRoute('route_a'),
          targetTag: targetTagForRoute('route_a'),
          ports: [5432],
          proto: 'tcp',
        },
      ],
    });
    const res = await cp.applyPolicyPlan(plan);
    // tag:dc-route_a already existed; tag:svc-route_a is created.
    expect(created).toContain('tag:svc-route_a');
    expect(res.policyIds).toEqual(['pol-1']);
    expect(res.groupIds['tag:dc-route_a']).toBe('g-existing');
  });
});

describe('NetbirdControlPlane error handling', () => {
  test('non-2xx surfaces as MeshControlPlaneError', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const cp = new NetbirdControlPlane({ managementUrl: 'https://x', serviceToken: 't', fetchImpl });
    await expect(cp.listPeers()).rejects.toThrow(MeshControlPlaneError);
  });
});
