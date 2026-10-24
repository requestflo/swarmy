import { describe, expect, it } from 'bun:test';
import { parseAppConfig, toDesired } from '@swarmy/app-config';
import { STOREFRONT_YAML } from '@/demo/resolvers/apps-config-file';
import { diffGraphs, graphOf, nodeIdOf } from './graph-model';
import { layoutGraph } from './graph-layout';

const graph = (text: string) => {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return graphOf(toDesired(r.config));
};

describe('demo storefront swarmy.yaml', () => {
  it('parses clean with the real parser', () => {
    expect(parseAppConfig(STOREFRONT_YAML).issues).toEqual([]);
  });
});

describe('graphOf', () => {
  const g = graph(STOREFRONT_YAML);
  it('draws addresses, schedules, services and resources from toDesired', () => {
    const byKind = (k: string) => g.nodes.filter((n) => n.kind === k).map((n) => n.name);
    expect(byKind('domain')).toEqual(['api.northwind.dev', 'shop.northwind.dev']);
    expect(byKind('service')).toEqual(['api', 'checkout', 'web', 'worker']);
    expect(byKind('resource')).toEqual(['cache', 'db', 'search', 'storefront-media']);
    expect(byKind('job')).toEqual(['cache-warmup', 'reindex-search', 'sitemap']);
    expect(g.nodes.find((n) => n.id === 'service:web')?.meta).toBe('build ./web · ×3');
    expect(g.nodes.find((n) => n.id === 'resource:db')?.meta).toBe('postgres 16 · standby');
  });
  it('links routes, jobs and bindings', () => {
    expect(g.edges).toContainEqual({ from: 'domain:shop.northwind.dev', to: 'service:web' });
    expect(g.edges).toContainEqual({ from: 'job:sitemap', to: 'service:web' });
    expect(g.edges).toContainEqual({ from: 'service:web', to: 'service:api' });
    expect(g.edges).toContainEqual({ from: 'service:api', to: 'resource:storefront-media' });
  });
  it('lays out three columns inside its box', () => {
    const l = layoutGraph(g);
    expect(new Set(l.nodes.map((n) => n.x)).size).toBe(3);
    expect(l.edges).toHaveLength(g.edges.length);
    for (const n of l.nodes) expect(n.y + n.h).toBeLessThanOrEqual(l.height);
  });
});

describe('diffGraphs', () => {
  const saved = graph(STOREFRONT_YAML);
  it('counts what an edit adds, removes and changes against the saved file', () => {
    const edited = STOREFRONT_YAML.replace('  search: { type: search, engine: meilisearch }\n', '$&  reports: postgres\n')
      .replace('  sitemap:\n    schedule: "30 3 * * *"\n    service: web\n    run: npm run sitemap\n    retries: 1\n', '')
      .replace('    replicas: 3\n', '    replicas: 5\n');
    const d = diffGraphs(saved, graph(edited));
    expect(d.chips.map((c) => c.text)).toEqual(['+1 resource', '−1 job', '1 changed']);
    expect(d.state.get('resource:reports')).toBe('added');
    expect(d.state.get('service:web')).toBe('changed');
    expect(d.removed.map((n) => n.id)).toEqual(['job:sitemap']);
  });
  it('is quiet for the saved file and marks a node a problem points into', () => {
    expect(diffGraphs(saved, saved).chips).toEqual([]);
    const issue = { severity: 'error' as const, code: 'schema/invalid', message: 'x', path: ['services', 'api', 'port'] };
    expect(nodeIdOf(issue)).toBe('service:api');
    expect(diffGraphs(saved, saved, [issue]).state.get('service:api')).toBe('bad');
  });
});
