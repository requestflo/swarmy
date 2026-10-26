import { describe, expect, it } from 'bun:test';
import type { DemoStore } from '../types';
import { appsPlanDiff } from './apps-plan-diff';

const store = (): DemoStore => ({ org: { id: 'o', name: 'o', slug: 'o', role: 'owner' }, user: { id: 'u', name: 'u', email: 'u@x' }, nodes: [], services: [], stacks: [], extra: {} });
const run = (name: string, input: unknown, s: DemoStore) => appsPlanDiff.handlers![name]!(input, s) as Record<string, unknown>;

describe('demo apps.planDiff / apps.plan (board 26)', () => {
  it('staging’s held plan drops search from a file that parses, with a spec on both sides', () => {
    const s = store();
    const v = run('apps.planDiff', { planId: 'plan-storefront-staging' }, s) as {
      base: { relation: string } | null;
      file: { before: string; after: string };
      spec: { before: string | null; after: string | null };
    };
    expect(v.base?.relation).toBe('live');
    expect(v.file.before).toContain('search: { type: search');
    expect(v.file.after).not.toContain('search: { type: search');
    expect(v.spec.before).toContain('type: search');
    expect(v.spec.after).not.toContain('type: search');
  });

  it('a PR compares with production as it runs, without a spec tab', () => {
    const v = run('apps.planDiff', { planId: 'plan-storefront-pr142' }, store()) as { base: { relation: string }; spec: unknown; file: { after: string } };
    expect(v.base.relation).toBe('live');
    expect(v.spec).toBeNull();
    expect(v.file.after).toContain('sessions: { type: cache');
  });

  it('apps.plan carries the app the plan leaves behind', () => {
    const p = run('apps.plan', { planId: 'plan-storefront-prod' }, store()) as { topology: { routes: Array<{ host: string; service: string }>; services: Array<{ name: string; uses: string[] }> } };
    expect(p.topology.routes).toContainEqual(expect.objectContaining({ host: 'shop.northwind.dev', service: 'web' }));
    expect(p.topology.services.find((x) => x.name === 'api')?.uses).toEqual(expect.arrayContaining(['db', 'cache', 'search']));
  });
});
