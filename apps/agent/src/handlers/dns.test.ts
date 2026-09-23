import { afterAll, describe, expect, it } from 'bun:test';
import type { DnsSnapshotBundle } from '@swarmy/core/protocol';
import { adminUrlCandidates, applyDns, parseDefaultGateway } from './dns';

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0
`;

describe('parseDefaultGateway', () => {
  it('decodes the little-endian default route (docker0 172.17.0.1)', () => {
    expect(parseDefaultGateway(ROUTE)).toBe('172.17.0.1');
  });
  it('undefined when there is no default route', () => {
    expect(parseDefaultGateway(ROUTE.split('\n').filter((l) => !l.includes('010011AC')).join('\n'))).toBeUndefined();
  });
});

describe('adminUrlCandidates', () => {
  const url = 'http://127.0.0.1:53535';
  it('host-netns (systemd) agent: only the controller loopback URL', () => {
    expect(adminUrlCandidates(url, { inContainer: false, gateway: '172.17.0.1' })).toEqual([url]);
  });
  it('container-backend agent: loopback first, then the docker0 gateway', () => {
    expect(adminUrlCandidates(`${url}/`, { inContainer: true, gateway: '172.17.0.1' })).toEqual([
      url,
      'http://172.17.0.1:53535',
    ]);
  });
  it('never rewrites a non-loopback URL', () => {
    expect(adminUrlCandidates('http://10.0.0.5:53535', { inContainer: true, gateway: '172.17.0.1' })).toEqual([
      'http://10.0.0.5:53535',
    ]);
  });
});

describe('applyDns push path', () => {
  const bundle = { version: 7, generatedAt: new Date().toISOString(), zones: [] } as unknown as DnsSnapshotBundle;
  const seen: Array<{ auth: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const auth = req.headers.get('authorization');
      seen.push({ auth, body: await req.json() });
      if (auth !== 'Bearer tok') return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ applied: true, version: 7, zones: 0 });
    },
  });
  afterAll(() => server.stop(true));
  const env = { inContainer: false, gateway: undefined };

  it('POSTs the bundle to <adminUrl>/v1/snapshot with the bearer token', async () => {
    const r = await applyDns(
      { commandId: '00000000-0000-4000-8000-000000000001', bundle, adminUrl: `http://127.0.0.1:${server.port}`, adminToken: 'tok' } as never,
      env,
    );
    expect(r).toEqual({ applied: true, version: 7, zones: 0 });
    expect(seen.at(-1)).toEqual({ auth: 'Bearer tok', body: bundle as unknown });
  });

  it('fails fast on 401 with the admin error', async () => {
    const before = seen.length;
    await expect(
      applyDns(
        { commandId: '00000000-0000-4000-8000-000000000001', bundle, adminUrl: `http://127.0.0.1:${server.port}`, adminToken: 'bad' } as never,
        env,
      ),
    ).rejects.toThrow('swarmy-dns admin 401: unauthorized');
    expect(seen.length - before).toBe(1);
  });

  it('names the unreachable URL when nothing listens (the "why" behind a failed push)', async () => {
    await expect(
      applyDns(
        { commandId: '00000000-0000-4000-8000-000000000001', bundle, adminUrl: 'http://127.0.0.1:1', adminToken: 'tok', timeoutMs: 500 } as never,
        env,
      ),
    ).rejects.toThrow('http://127.0.0.1:1/v1/snapshot');
  }, 10_000);
});
