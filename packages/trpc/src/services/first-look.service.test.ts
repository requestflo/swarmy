import { beforeEach, describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import type { DomainView } from './ingress.service';
import type { ProbeResult, ProbeTarget } from './first-look-probe';
import { firstLook, resetFirstLookCache, type FirstLookDeps } from './first-look.service';

const svc = (name: string, stack: string, running: number, desired: number) => ({
  id: `id-${name}`,
  name,
  image: 'img:1',
  mode: 'replicated',
  desiredReplicas: desired,
  runningReplicas: running,
  createdAt: 0,
  updatedAt: 0,
  labels: { 'com.docker.stack.namespace': stack },
  networks: [],
  env: [],
  ports: [],
  secrets: [],
  configs: [],
  mounts: [],
});

const ctx = {
  activeOrgId: 'org1',
  hub: {
    liveInventory: () => ({
      services: [svc('blog_ghost', 'blog', 1, 1), svc('blog_mysql', 'blog', 1, 1), svc('shop_web', 'shop', 0, 2)],
      containers: [],
    }),
  },
} as unknown as OrgContext;

const route = (host: string, over: Partial<DomainView> = {}): DomainView =>
  ({ id: host, host, stack: 'blog', tls: 'auto', auto: false, pathPrefix: null, status: null, ...over }) as DomainView;

const OK: ProbeResult = {
  ok: true,
  ttfbMs: 96,
  status: 200,
  location: null,
  tls: { authorized: true, error: null, validTo: 'Dec 23 10:41:00 2026 GMT' },
};

function deps(over: Partial<FirstLookDeps> & { routes?: DomainView[]; answers?: ProbeResult[] } = {}) {
  const probes: ProbeTarget[] = [];
  const answers = [...(over.answers ?? [OK])];
  const d: FirstLookDeps = {
    listDomains: async () => over.routes ?? [route('blog.example.com')],
    edgeIps: over.edgeIps ?? (async () => ['203.0.113.10']),
    probe: async (t) => (probes.push(t), answers.shift() ?? OK),
    now: over.now ?? (() => Date.parse('2026-09-26T10:41:00Z')),
  };
  return { d, probes };
}

beforeEach(() => resetFirstLookCache());

describe('deploys.firstLook (SSRF: only this app’s own addresses, only via swarmy’s edge)', () => {
  it('refuses a host that is not one of the stack’s routes, before dialling anything', async () => {
    const { d, probes } = deps();
    await expect(firstLook(ctx, { stack: 'blog', host: '169.254.169.254' }, d)).rejects.toThrow(/isn't one of blog's addresses/);
    await expect(firstLook(ctx, { stack: 'blog', host: 'shop.example.com' }, d)).rejects.toThrow(/isn't one of blog's addresses/);
    expect(probes).toEqual([]);
  });

  it('dials the org’s edge IP with the host as SNI, never the host’s own DNS', async () => {
    const { d, probes } = deps();
    await firstLook(ctx, { stack: 'blog' }, d);
    expect(probes).toEqual([{ ip: '203.0.113.10', host: 'blog.example.com', path: '/', timeoutMs: 5_000 }]);
  });

  it('never probes when no edge IP is known, or one isn’t an IP', async () => {
    const { d, probes } = deps({ edgeIps: async () => ['edge.internal'] });
    const v = await firstLook(ctx, { stack: 'blog' }, d);
    expect(probes).toEqual([]);
    expect(v.response).toEqual({ ok: false, error: 'swarmy doesn’t know an edge address to check it through yet' });
  });

  it('the result: first response, HTTPS from the handshake, copies across the app', async () => {
    const { d } = deps();
    expect(await firstLook(ctx, { stack: 'blog' }, d)).toEqual({
      stack: 'blog',
      host: 'blog.example.com',
      checkedAt: '2026-09-26T10:41:00.000Z',
      response: { ok: true, ms: 96, status: 200 },
      https: { valid: true, validUntil: '2026-12-23T10:41:00.000Z', source: 'handshake', error: null },
      copies: { running: 2, desired: 2 },
    });
  });

  it('prefers the edge certificate check when the route has one', async () => {
    const certificate = { issuer: 'R11', expiresAt: '2026-12-20T00:00:00.000Z', error: null, edges: [{ ip: '203.0.113.10', ok: true }], checkedAt: null };
    const { d } = deps({ routes: [route('blog.example.com', { status: { certificate } as DomainView['status'] })] });
    const v = await firstLook(ctx, { stack: 'blog' }, d);
    expect(v.https).toEqual({ valid: true, validUntil: '2026-12-20T00:00:00.000Z', source: 'edge-check', error: null });
  });

  it('a timeout is a plain failed line, not a number', async () => {
    const { d } = deps({ answers: [{ ok: false, error: 'no answer within 5 s', tls: null }] });
    const v = await firstLook(ctx, { stack: 'blog' }, d);
    expect(v.response).toEqual({ ok: false, error: 'no answer within 5 s' });
    expect(v.https).toBeNull();
  });

  it('follows one same-host redirect, never one to another host', async () => {
    const hop: ProbeResult = { ...OK, status: 301, location: '/ghost/' };
    const one = deps({ answers: [hop, OK] });
    await firstLook(ctx, { stack: 'blog' }, one.d);
    expect(one.probes.map((p) => p.path)).toEqual(['/', '/ghost/']);

    resetFirstLookCache();
    const away = deps({ answers: [{ ...OK, status: 302, location: 'https://evil.example.net/' }] });
    const v = await firstLook(ctx, { stack: 'blog' }, away.d);
    expect(away.probes).toHaveLength(1);
    expect(v.response).toEqual({ ok: true, ms: 96, status: 302 });
  });

  it('probes at most once per 10 s per app', async () => {
    let now = 0;
    const { d, probes } = deps({ now: () => now });
    await firstLook(ctx, { stack: 'blog' }, d);
    now = 9_000;
    await firstLook(ctx, { stack: 'blog' }, d);
    expect(probes).toHaveLength(1);
    now = 10_500;
    await firstLook(ctx, { stack: 'blog' }, d);
    expect(probes).toHaveLength(2);
  });

  it('another org’s (or no) app is not found', async () => {
    const { d } = deps();
    await expect(firstLook(ctx, { stack: 'nope' }, d)).rejects.toThrow();
  });
});
