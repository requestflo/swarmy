import { describe, expect, it, mock } from 'bun:test';
import {
  buildTunnelConfigPayload,
  CloudflareApiError,
  CloudflareClient,
  type CloudflareIngressRule,
} from './cloudflare.client';

describe('buildTunnelConfigPayload', () => {
  it('always terminates with the catch-all 404', () => {
    const rules: CloudflareIngressRule[] = [
      { hostname: 'a.example.com', service: 'http://web:3000' },
      { hostname: 'b.example.com', service: 'http://api:8080', path: '/v1' },
    ];
    const { config } = buildTunnelConfigPayload(rules);
    expect(config.ingress).toHaveLength(3);
    expect(config.ingress[0]).toEqual({ hostname: 'a.example.com', service: 'http://web:3000' });
    expect(config.ingress[2]).toEqual({ service: 'http_status:404' });
  });

  it('de-duplicates a caller-supplied catch-all', () => {
    const rules: CloudflareIngressRule[] = [
      { hostname: 'a.example.com', service: 'http://web:3000' },
      { service: 'http_status:404' },
    ];
    const { config } = buildTunnelConfigPayload(rules);
    // The trailing catch-all (no hostname) is stripped and re-appended once.
    expect(config.ingress).toHaveLength(2);
    expect(config.ingress.filter((r) => r.hostname === undefined)).toHaveLength(1);
  });

  it('produces a single catch-all even with zero hostnames', () => {
    const { config } = buildTunnelConfigPayload([]);
    expect(config.ingress).toEqual([{ service: 'http_status:404' }]);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CloudflareClient (stubbed fetch)', () => {
  it('creates a tunnel and returns id + token', async () => {
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/accounts/acct_1/cfd_tunnel');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ name: 'swarmy', config_src: 'cloudflare' });
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok_secret');
      return jsonResponse({ success: true, errors: [], messages: [], result: { id: 't_1', name: 'swarmy', token: 'runtok' } });
    });
    const client = new CloudflareClient({ apiToken: 'tok_secret', accountId: 'acct_1', fetchImpl: fetchImpl as unknown as typeof fetch });
    const t = await client.createTunnel('swarmy');
    expect(t.id).toBe('t_1');
    expect(t.token).toBe('runtok');
  });

  it('PUTs the full ingress array on configuration', async () => {
    let captured: unknown;
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/cfd_tunnel/t_1/configurations');
      expect(init?.method).toBe('PUT');
      captured = JSON.parse(String(init?.body));
      return jsonResponse({ success: true, errors: [], messages: [], result: {} });
    });
    const client = new CloudflareClient({ apiToken: 'x', accountId: 'a', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.putTunnelConfiguration('t_1', [{ hostname: 'h.example.com', service: 'http://web:3000' }]);
    expect(captured).toEqual({
      config: { ingress: [{ hostname: 'h.example.com', service: 'http://web:3000' }, { service: 'http_status:404' }] },
    });
  });

  it('upserts a DNS CNAME — POST when absent, PUT when present', async () => {
    const calls: { method: string; url: string }[] = [];
    const absentFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ success: true, errors: [], messages: [], result: [] });
      }
      return jsonResponse({ success: true, errors: [], messages: [], result: { id: 'd_1' } });
    });
    const c1 = new CloudflareClient({ apiToken: 'x', accountId: 'a', fetchImpl: absentFetch as unknown as typeof fetch });
    await c1.upsertDnsCname('zone_1', 'app.example.com', 't_1');
    expect(calls.some((c) => c.method === 'POST')).toBe(true);

    calls.length = 0;
    const presentFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ success: true, errors: [], messages: [], result: [{ id: 'd_9', name: 'app.example.com' }] });
      }
      return jsonResponse({ success: true, errors: [], messages: [], result: { id: 'd_9' } });
    });
    const c2 = new CloudflareClient({ apiToken: 'x', accountId: 'a', fetchImpl: presentFetch as unknown as typeof fetch });
    await c2.upsertDnsCname('zone_1', 'app.example.com', 't_1');
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/dns_records/d_9'))).toBe(true);
  });

  it('throws CloudflareApiError on an error envelope', async () => {
    const fetchImpl = mock(async () =>
      jsonResponse({ success: false, errors: [{ code: 1001, message: 'bad token' }], messages: [], result: null }, 403),
    );
    const client = new CloudflareClient({ apiToken: 'x', accountId: 'a', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listTunnels()).rejects.toBeInstanceOf(CloudflareApiError);
  });
});
