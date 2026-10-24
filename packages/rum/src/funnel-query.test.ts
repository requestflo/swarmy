import { describe, expect, it } from 'bun:test';
import { buildFunnelQuery, likePattern, stepCondition } from './funnel-query';
import { FunnelsSchema, funnelStepName, readRumFunnels, RUM_FUNNELS_LABEL, serializeRumFunnels } from './funnels';

const STEPS = [{ path: '/cart' }, { path: '/checkout/*' }, { path: '/checkout/*', event: 'paid' }];

describe('funnel SQL is org + app scoped and escapes everything', () => {
  it('carries the org wall and one windowFunnel condition per step', () => {
    const sql = buildFunnelQuery('org_1', 'shop', { steps: STEPS });
    expect(sql).toContain("WHERE org_id = 'org_1' AND app = 'shop' AND ts >= now() - INTERVAL 7 DAY AND kind IN ('pv', 'ev')");
    expect(sql).toContain('windowFunnel(3600)(toDateTime(ts),');
    expect(sql).toContain("(kind = 'pv' AND path = '/cart'),");
    expect(sql).toContain("(kind = 'pv' AND path LIKE '/checkout/%'),");
    expect(sql).toContain("(kind = 'ev' AND event_name = 'paid' AND path LIKE '/checkout/%')) AS lvl");
    expect(sql).toContain('SELECT visit AS unit');
    expect(sql).not.toContain("uid != ''");
    expect(sql).toContain("SELECT '' AS release, level, count() AS units");
  });

  it('quotes are escaped, numbers clamped', () => {
    const evil = "x' OR 1=1 --";
    const sql = buildFunnelQuery(evil, evil, { steps: [{ path: '/a', event: evil }, { path: '/b' }], days: 9999, windowMinutes: 1 });
    expect(sql).toContain("org_id = 'x\\' OR 1=1 --' AND app = 'x\\' OR 1=1 --'");
    expect(sql).toContain("event_name = 'x\\' OR 1=1 --'");
    expect(sql).toContain('INTERVAL 90 DAY');
    expect(sql).toContain('windowFunnel(300)');
    expect(() => buildFunnelQuery('o', 'a', { steps: [{ path: '/only' }] })).toThrow();
  });

  it('globs become LIKE patterns with % and _ escaped; /* matches every page', () => {
    expect(likePattern('/p_1/*%')).toBe('/p\\_1/%\\%');
    // The literal backslash before _ is itself escaped inside the SQL string.
    expect(stepCondition({ path: '/p_1/*' })).toBe("(kind = 'pv' AND path LIKE '/p\\\\_1/%')");
    expect(stepCondition({ path: '/*', event: 'signup' })).toBe("(kind = 'ev' AND event_name = 'signup')");
  });

  it('signed-in people are grouped by user id, visits without one dropped', () => {
    const sql = buildFunnelQuery('org_1', 'shop', { steps: STEPS, signedIn: true });
    expect(sql).toContain('SELECT uid AS unit');
    expect(sql).toContain("WHERE lvl > 0 AND uid != ''");
  });

  it('a visit is named by the newest release live when it began (at most 12)', () => {
    const releases = Array.from({ length: 14 }, (_, i) => ({ id: `rel${i}`, fromMs: 1_000 * (i + 1) }));
    const sql = buildFunnelQuery('org_1', 'shop', { steps: STEPS, releases: [...releases, { id: "r'x", fromMs: Number.NaN }] });
    expect(sql).toContain("multiIf(toUnixTimestamp64Milli(started) >= 14000, 'rel13', toUnixTimestamp64Milli(started) >= 13000, 'rel12'");
    expect(sql).toContain(">= 3000, 'rel2', '') AS release");
    expect(sql).not.toContain("'rel1'");
    expect(sql).not.toContain("r\\'x");
  });
});

describe('funnel definitions (the swarmy.rum.funnels label)', () => {
  const funnel = { id: 'checkout', name: 'Checkout', steps: [{ path: '/cart/' }, { path: '/paid', name: 'paid' }] };

  it('reads tolerantly and serialises stably', () => {
    expect(readRumFunnels(undefined)).toEqual([]);
    expect(readRumFunnels({ [RUM_FUNNELS_LABEL]: '{nope' })).toEqual([]);
    const value = serializeRumFunnels(FunnelsSchema.parse([funnel]));
    expect(value).toBe('[{"id":"checkout","name":"Checkout","steps":[{"path":"/cart"},{"name":"paid","path":"/paid"}],"windowMinutes":60}]');
    expect(readRumFunnels({ [RUM_FUNNELS_LABEL]: value })[0]?.steps[0]?.path).toBe('/cart');
  });

  it('refuses unsafe paths, duplicate ids and one-step funnels', () => {
    expect(FunnelsSchema.safeParse([{ ...funnel, steps: [{ path: "/a'" }, { path: '/b' }] }]).success).toBe(false);
    expect(FunnelsSchema.safeParse([{ ...funnel, steps: [{ path: 'cart' }, { path: '/b' }] }]).success).toBe(false);
    expect(FunnelsSchema.safeParse([funnel, funnel]).success).toBe(false);
    expect(FunnelsSchema.safeParse([{ ...funnel, steps: [{ path: '/a' }] }]).success).toBe(false);
  });

  it('names a step from its name, event or path', () => {
    expect(funnelStepName({ path: '/checkout/*' })).toBe('checkout');
    expect(funnelStepName({ path: '/*', event: 'purchase' })).toBe('purchase');
    expect(funnelStepName({ path: '/' })).toBe('home');
    expect(funnelStepName({ path: '/x', name: 'paid' })).toBe('paid');
  });
});
