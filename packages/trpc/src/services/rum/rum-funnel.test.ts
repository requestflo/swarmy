import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { RUM_FUNNELS_LABEL, RUM_SETTINGS_LABEL, serializeRumFunnels } from '@swarmy/rum';
import { setRumFunnels } from './rum-funnels.service';
import { funnel } from './rum-funnel';

const FUNNEL = { id: 'checkout', name: 'Checkout', windowMinutes: 60, steps: [{ path: '/cart' }, { path: '/checkout' }, { path: '/paid' }] };
const HOUR = 3_600_000;

function svc(name: string, labels: Record<string, string>) {
  return {
    id: name, name, image: 'x', mode: 'replicated', desiredReplicas: 1, runningReplicas: 1,
    labels: { 'com.docker.stack.namespace': 'shop', ...labels }, networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
  };
}

/** An in-memory OrgContext: live services, two releases of `shop`, a recording audit log and hub. */
function mockCtx(labels: Record<string, string>, opts: { second?: Record<string, string> } = {}) {
  const writes: Array<{ service: string; add: Record<string, string>; removeKeys: string[] }> = [];
  const audits: Array<{ action: string; metadata: unknown }> = [];
  const releaseQueries: unknown[] = [];
  const services = [svc('shop_web', labels), svc('shop_api', opts.second ?? labels)];
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: {
      auditLog: { create: async ({ data }: { data: { action: string; metadata: unknown } }) => audits.push(data) },
      release: {
        findMany: async (q: unknown) => {
          releaseQueries.push(q);
          return [{ id: 'rel-new', createdAt: new Date(Date.now() - HOUR), imagesJson: [{ name: 'web', image: 'ghcr.io/n/web:1.9.0' }] }];
        },
        findFirst: async () => ({ id: 'rel-old', createdAt: new Date(Date.now() - 30 * 24 * HOUR), imagesJson: [] }),
      },
    },
    hub: {
      liveInventory: () => ({ services, containers: [] }),
      managerNode: () => 'n1',
      isOnline: () => true,
      dispatch: async (_n: string, _c: string, p: (typeof writes)[number]) => {
        writes.push(p);
        return {};
      },
    },
  } as never;
  return { ctx, writes, audits, releaseQueries };
}

describe('setRumFunnels (the swarmy.rum.funnels label)', () => {
  it('stamps every service that differs, audits, and answers with what it saved', async () => {
    const saved = serializeRumFunnels([FUNNEL]);
    const m = mockCtx({}, { second: { [RUM_FUNNELS_LABEL]: saved } });
    const view = await setRumFunnels(m.ctx, { stack: 'shop', funnels: [FUNNEL] });
    expect(m.writes).toEqual([{ service: 'shop_web', add: { [RUM_FUNNELS_LABEL]: saved }, removeKeys: [] }]);
    expect(m.audits[0]).toMatchObject({ action: 'rum.funnels.update', metadata: { funnels: [{ id: 'checkout', steps: 3 }] } });
    expect(view.funnels.map((f) => f.id)).toEqual(['checkout']);
  });

  it('an empty list removes the label', async () => {
    const m = mockCtx({ [RUM_FUNNELS_LABEL]: serializeRumFunnels([FUNNEL]) });
    const view = await setRumFunnels(m.ctx, { stack: 'shop', funnels: [] });
    expect(m.writes.map((w) => w.removeKeys)).toEqual([[RUM_FUNNELS_LABEL], [RUM_FUNNELS_LABEL]]);
    expect(view.funnels).toEqual([]);
  });
});

describe('rum.funnel over a stub ClickHouse', () => {
  const seen: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  const prev = process.env.SWARMY_RUM_CLICKHOUSE_DSN;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const sql = await req.text();
        if (!sql.includes('windowFunnel')) return new Response('');
        seen.push(sql);
        // Before rel-new: 100 reach checkout, 75 pay. Since: 100 reach checkout, 35 pay.
        const rows = [
          { release: 'rel-old', level: 2, units: 25 }, { release: 'rel-old', level: 3, units: 75 },
          { release: 'rel-new', level: 1, units: 20 }, { release: 'rel-new', level: 2, units: 65 }, { release: 'rel-new', level: 3, units: 35 },
        ];
        return new Response(rows.map((r) => JSON.stringify(r)).join('\n'));
      },
    });
    process.env.SWARMY_RUM_CLICKHOUSE_DSN = `http://it:it@localhost:${server.port}/otel`;
  });
  afterAll(() => {
    server.stop(true);
    if (prev === undefined) delete process.env.SWARMY_RUM_CLICKHOUSE_DSN;
    else process.env.SWARMY_RUM_CLICKHOUSE_DSN = prev;
  });

  const labels = { [RUM_FUNNELS_LABEL]: serializeRumFunnels([FUNNEL]) };

  it('an unknown funnel id reads as no-funnel', async () => {
    expect((await funnel(mockCtx(labels).ctx, { stack: 'shop', funnel: 'nope' })).status).toBe('no-funnel');
  });

  it('steps, the biggest drop and the release since which it fell', async () => {
    const m = mockCtx(labels);
    const v = await funnel(m.ctx, { stack: 'shop', funnel: 'checkout', days: 7, signedIn: true });
    expect(v.status).toBe('ok');
    expect(v.audience).toBe('visits'); // privacy mode: signedIn is ignored
    expect(seen.at(-1)).toContain("org_id = 'org1' AND app = 'shop'");
    expect(seen.at(-1)).not.toContain("uid != ''");
    expect(v.steps.map((s) => [s.name, s.visitors])).toEqual([['cart', 220], ['checkout', 200], ['paid', 110]]);
    expect(v.biggestDrop).toMatchObject({ index: 2, from: 'checkout', to: 'paid', lost: 90 });
    expect(v.since).toMatchObject({ releaseId: 'rel-new', image: 'ghcr.io/n/web:1.9.0', before: 0.75, after: 0.35 });
    expect(v.releases.map((r) => [r.releaseId, r.reached, r.converted])).toEqual([['rel-new', 100, 35], ['rel-old', 100, 75]]);
    expect(m.releaseQueries[0]).toMatchObject({ where: { orgId: 'org1', stackName: 'shop' } });
  });

  it('identified mode honours signed-in people only', async () => {
    const identified = { ...labels, [RUM_SETTINGS_LABEL]: JSON.stringify({ enabled: true, mode: 'identified' }) };
    const v = await funnel(mockCtx(identified).ctx, { stack: 'shop', funnel: 'checkout', signedIn: true });
    expect(v.audience).toBe('signed-in');
    expect(seen.at(-1)).toContain("WHERE lvl > 0 AND uid != ''");
  });
});
