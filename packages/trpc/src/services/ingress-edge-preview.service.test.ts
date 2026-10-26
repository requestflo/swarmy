import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { previewEdgeConfigs, type EdgePreviewDeps } from './ingress-edge-preview.service';

const HASH = `$2a$10$${'b'.repeat(53)}`;

function config(domains: Record<string, unknown>[], driver = 'caddy'): IngressConfig {
  return IngressConfigSchema.parse({
    driver,
    orgId: 'org_1',
    domains,
    globalOptions: { extraConfig: { applyVia: 'local' } },
  });
}

const regionUpstreams = [
  { service: 'shop_web-eu-west', port: 3000, region: 'eu-west' },
  { service: 'shop_web-us-east', port: 3000, region: 'us-east' },
];

const ctx = {
  activeOrgId: 'org_1',
  db: { node: { findMany: async () => [{ id: 'n-lon', name: 'london-1' }, { id: 'n-nyc', name: 'new-york-1' }] } },
  hub: { nodeInfoFor: (id: string) => ({ hostname: `${id}.host` }) },
} as unknown as OrgContext;

function deps(cfg: IngressConfig): EdgePreviewDeps {
  return {
    loadConfig: async () => cfg,
    targets: async () => [
      { nodeId: 'n-nyc', region: 'us-east' },
      { nodeId: 'n-lon', region: 'eu-west' },
      { nodeId: 'n-new' },
    ],
  };
}

const text = (r: { localReload?: { file?: { contents: string } } }): string => r.localReload?.file?.contents ?? '';

describe('previewEdgeConfigs — the Caddyfile each edge runs', () => {
  it('renders each edge with its own region first, named and sorted', async () => {
    const view = await previewEdgeConfigs(ctx, deps(config([{ domain: 'shop.acme.com', service: 'shop_web', port: 3000, regionUpstreams }])));
    expect(view.regional).toBe(true);
    expect(view.edges.map((e) => [e.name, e.region])).toEqual([
      ['london-1', 'eu-west'],
      ['n-new.host', null],
      ['new-york-1', 'us-east'],
    ]);
    const [lon, unlabelled, nyc] = view.edges.map((e) => text(e.rendered));
    expect(lon).toContain('reverse_proxy shop_web-eu-west:3000 shop_web-us-east:3000 {');
    expect(nyc).toContain('reverse_proxy shop_web-us-east:3000 shop_web-eu-west:3000 {');
    // No region label: stable region-name order, as the driver renders it.
    expect(unlabelled).toContain('reverse_proxy shop_web-eu-west:3000 shop_web-us-east:3000 {');
  });

  it('every edge runs the same file when no route has region copies', async () => {
    const view = await previewEdgeConfigs(ctx, deps(config([{ domain: 'shop.acme.com', service: 'shop_web', port: 3000 }])));
    expect(view.regional).toBe(false);
    const files = view.edges.map((e) => text(e.rendered));
    expect(new Set(files).size).toBe(1);
    expect(files[0]).toContain('reverse_proxy shop_web:3000 {');
  });

  it('seals route-password hashes, as previewConfig does', async () => {
    const view = await previewEdgeConfigs(
      ctx,
      deps(config([{ domain: 'ops.acme.com', service: 'grafana', port: 3001, basicAuth: { users: [{ username: 'ops', hash: HASH }] } }])),
    );
    const all = JSON.stringify(view);
    expect(all).toContain('basic_auth');
    expect(all).not.toContain(HASH);
  });

  it('lists no edges when the front door is not swarmy’s Caddy', async () => {
    const view = await previewEdgeConfigs(ctx, deps(config([], 'none')));
    expect(view).toEqual({ regional: false, edges: [] });
  });
});
