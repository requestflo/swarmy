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
