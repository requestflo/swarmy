import { describe, expect, it } from 'bun:test';
import { caddyTabs, pickEdges, type EdgeRender } from './edge-caddy-model';

function edge(nodeId: string, name: string, region: string | null, contents: string): EdgeRender {
  return { nodeId, name, region, rendered: { files: [], localReload: { service: 'swarmy-ingress-caddy', file: { path: '/etc/caddy/Caddyfile', contents } } } };
}

const file = (first: string, second: string): string =>
  `shop.acme.com {\n  reverse_proxy ${first}:3000 ${second}:3000 {\n    lb_policy first\n  }\n}`;
const lon = edge('n-lon', 'london-1', 'eu-west', file('web-eu-west', 'web-us-east'));
const nyc = edge('n-nyc', 'new-york-1', 'us-east', file('web-us-east', 'web-eu-west'));

describe('pickEdges', () => {
  it('defaults to the first two and never compares an edge with itself', () => {
    expect(pickEdges([lon, nyc], null, null)).toEqual({ edge: lon, other: nyc });
    expect(pickEdges([lon, nyc], 'n-nyc', 'n-nyc')).toEqual({ edge: nyc, other: lon });
    expect(pickEdges([lon], 'gone', null)).toEqual({ edge: lon, other: undefined });
  });
});

describe('caddyTabs', () => {
  it('shows the picked address on this edge, the whole file and the diff against the other edge', () => {
    const tabs = caddyTabs({ selected: 'shop.acme.com', edge: lon, other: nyc, text: null, pending: false, regional: true });
    expect(tabs.map((t) => t.label)).toEqual(['shop.acme.com', 'Whole file', 'vs new-york-1']);
    expect(tabs[0]!.code).toContain('reverse_proxy web-eu-west:3000 web-us-east:3000 {');
    expect(tabs[2]!.code).toContain('--- london-1 (eu-west)\n+++ new-york-1 (us-east)');
    expect(tabs[2]!.code).toContain('+  reverse_proxy web-us-east:3000 web-eu-west:3000 {');
  });

  it('says so when two edges run the same file', () => {
    const twin = edge('n-par', 'paris-1', 'eu-west', lon.rendered.localReload!.file!.contents);
    const tabs = caddyTabs({ selected: null, edge: lon, other: twin, text: null, pending: false, regional: false });
    expect(tabs[1]!.code).toBe('# london-1 and paris-1 run the same Caddyfile, byte for byte.\n# No app has copies in more than one region, so every edge renders the same file.');
  });

  it('falls back to the org-wide render when no edge is running', () => {
    const tabs = caddyTabs({ selected: null, text: 'a.com {\n}', pending: false, regional: false });
    expect(tabs).toEqual([{ label: 'Whole file', code: 'a.com {\n}' }]);
  });
});
