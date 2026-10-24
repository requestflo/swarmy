import { describe, expect, it } from 'bun:test';
import { SwarmyClient, SwarmyApiError } from '../src/index.js';
import type { FetchLike } from '../src/index.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(
  responder: (url: string, init?: RequestInit) => Response,
): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('URL + header construction', () => {
  it('appends /api/v1 and sets bearer auth on GET list', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [], next_cursor: null }));
    const client = new SwarmyClient({ endpoint: 'https://swarm.example.com/', apiKey: 'swk_test', fetch });

    await client.services.list();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://swarm.example.com/api/v1/services');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer swk_test');
    expect(headers.Accept).toContain('application/problem+json');
    expect(calls[0]!.init!.method).toBe('GET');
  });

  it('does not double-append /api/v1 when already present', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [], next_cursor: null }));
    const client = new SwarmyClient({ endpoint: 'https://swarm.example.com/api/v1', apiKey: 'swk_x', fetch });
    await client.nodes.list();
    expect(calls[0]!.url).toBe('https://swarm.example.com/api/v1/nodes');
  });

  it('encodes path ids and serialises JSON bodies on POST', async () => {
    const { fetch, calls } = mockFetch(() => json({ id: 's1', deployment_id: 'd1' }, 202));
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });

    const ref = await client.services.scale('svc/with space', 3);

    expect(calls[0]!.url).toBe('http://x/api/v1/services/svc%2Fwith%20space/scale');
    expect(calls[0]!.init!.method).toBe('POST');
    expect((calls[0]!.init!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ replicas: 3 });
    expect(ref.deployment_id).toBe('d1');
  });

  it('passes cursor + limit as query params', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [], next_cursor: null }));
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });
    await client.stacks.list({ cursor: 'abc', limit: 50 });
    expect(calls[0]!.url).toBe('http://x/api/v1/stacks?cursor=abc&limit=50');
  });

  it('maps problem+json errors to SwarmyApiError', async () => {
    const problem = {
      type: 'https://swarmy.dev/errors/not-found',
      title: 'Not Found',
      status: 404,
      detail: 'no such service',
      swarmy_code: 'service_not_found',
    };
    const { fetch } = mockFetch(
      () =>
        new Response(JSON.stringify(problem), {
          status: 404,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
    );
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });

    await expect(client.services.get('missing')).rejects.toThrow(SwarmyApiError);
    try {
      await client.services.get('missing');
    } catch (e) {
      const err = e as SwarmyApiError;
      expect(err.status).toBe(404);
      expect(err.code).toBe('service_not_found');
      expect(err.problem.detail).toBe('no such service');
      expect(err.message).toBe('no such service');
    }
  });

  it('paginates via iterate(), following next_cursor', async () => {
    let call = 0;
    const { fetch } = mockFetch(() => {
      call += 1;
      if (call === 1) return json({ data: [{ id: 'a' }, { id: 'b' }], next_cursor: 'p2' });
      return json({ data: [{ id: 'c' }], next_cursor: null });
    });
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });

    const ids: string[] = [];
    for await (const svc of client.services.iterate()) ids.push(svc.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('throws when endpoint or apiKey is missing', () => {
    // @ts-expect-error intentional misuse
    expect(() => new SwarmyClient({ apiKey: 'swk_y', fetch: (async () => new Response()) as FetchLike })).toThrow();
    // @ts-expect-error intentional misuse
    expect(() => new SwarmyClient({ endpoint: 'http://x', fetch: (async () => new Response()) as FetchLike })).toThrow();
  });
});

describe('connect apps', () => {
  const link = { stack: 'shop', peer: 'billing', network: 'swarmy-link-ab12', services: ['billing_api'] };

  it('endpoints / connect / disconnect hit the stack sub-resources', async () => {
    const { fetch, calls } = mockFetch((url) =>
      url.endsWith('/endpoints') ? json({ stack: 'shop', connected_apps: [], services: [], resources: [] }) : json(link),
    );
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });

    expect((await client.stacks.endpoints('shop')).stack).toBe('shop');
    expect(await client.stacks.connect('st 1', 'billing')).toEqual(link);
    await client.stacks.disconnect('shop', 'bill/ing');

    expect(calls.map((c) => `${c.init!.method} ${c.url}`)).toEqual([
      'GET http://x/api/v1/stacks/shop/endpoints',
      'POST http://x/api/v1/stacks/st%201/connections',
      'DELETE http://x/api/v1/stacks/shop/connections/bill%2Fing',
    ]);
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ peer: 'billing' });
  });

  it('a 412 admission refusal exposes its violations', async () => {
    const problem = {
      type: 'https://swarmy.dev/problems/precondition_failed',
      title: 'Precondition Failed',
      status: 412,
      detail: 'Deployment blocked by policy',
      swarmy_code: 'POLICY_DENIED',
      violations: [{ rule: 'no-latest-tag-in-prod', severity: 'block', message: 'pin a tag', resource: 'shop_web' }],
    };
    const { fetch } = mockFetch(
      () => new Response(JSON.stringify(problem), { status: 412, headers: { 'Content-Type': 'application/problem+json' } }),
    );
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });
    const err = (await client.services.create({ name: 'web', image: 'nginx:latest' }).catch((e) => e)) as SwarmyApiError;
    expect(err).toBeInstanceOf(SwarmyApiError);
    expect(err.status).toBe(412);
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.violations).toEqual(problem.violations as SwarmyApiError['violations']);
  });
});

describe('service update + join tokens', () => {
  it('update PATCHes the service with only the fields given', async () => {
    const { fetch, calls } = mockFetch(() => json({ id: 'svc-1', deployment_id: 'svc-1' }, 202));
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });

    const ref = await client.services.update('svc 1', { image: 'nginx:1.28', env: [{ key: 'A', value: '1' }] });

    expect(`${calls[0]!.init!.method} ${calls[0]!.url}`).toBe('PATCH http://x/api/v1/services/svc%201');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ image: 'nginx:1.28', env: [{ key: 'A', value: '1' }] });
    expect(ref.deployment_id).toBe('svc-1');
  });

  it('joinTokens list / create / revoke', async () => {
    const issued = {
      id: 'jt1', token: 'swt_ab12cd34_x', label: 'ci', profile: null, expires_at: '2026-10-01T01:00:00.000Z', max_uses: 1,
      mesh: null, install: { url: 'https://swarm.example.com', loopback: false, warning: null },
    };
    const { fetch, calls } = mockFetch((_url, init) =>
      init?.method === 'POST' ? json(issued, 201)
        : init?.method === 'DELETE' ? json({ id: 'jt1', revoked: true })
          : json({ data: [], next_cursor: null }),
    );
    const client = new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch });

    expect((await client.joinTokens.create({ label: 'ci', ttl_seconds: 600 })).token).toBe('swt_ab12cd34_x');
    expect((await client.joinTokens.list()).data).toEqual([]);
    expect((await client.joinTokens.revoke('jt1')).revoked).toBe(true);
    expect(calls.map((c) => `${c.init!.method} ${c.url}`)).toEqual([
      'POST http://x/api/v1/join-tokens',
      'GET http://x/api/v1/join-tokens',
      'DELETE http://x/api/v1/join-tokens/jt1',
    ]);
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ label: 'ci', ttl_seconds: 600 });
  });
});
