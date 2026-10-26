import { describe, expect, it } from 'bun:test';
import { edgeDiff } from './edge-diff';

const london = [
  '{',
  '  metrics {',
  '    per_host',
  '  }',
  '}',
  '',
  'api.northwind.dev {',
  '  reverse_proxy storefront_api-eu-west:8080 storefront_api-us-east:8080 {',
  '    lb_policy first',
  '  }',
  '}',
].join('\n');
const newYork = london.replace(
  'storefront_api-eu-west:8080 storefront_api-us-east:8080',
  'storefront_api-us-east:8080 storefront_api-eu-west:8080',
);

describe('edgeDiff — one edge’s Caddyfile against another', () => {
  it('is null when both edges run the same file', () => {
    expect(edgeDiff({ label: 'a', text: london }, { label: 'b', text: london })).toBeNull();
  });

  it('renders a unified diff with three lines of context', () => {
    expect(edgeDiff({ label: 'london-1 (eu-west)', text: london }, { label: 'new-york-1 (us-east)', text: newYork })).toBe(
      [
        '--- london-1 (eu-west)',
        '+++ new-york-1 (us-east)',
        '@@ -5,7 +5,7 @@',
        ' }',
        ' ',
        ' api.northwind.dev {',
        '-  reverse_proxy storefront_api-eu-west:8080 storefront_api-us-east:8080 {',
        '+  reverse_proxy storefront_api-us-east:8080 storefront_api-eu-west:8080 {',
        '     lb_policy first',
        '   }',
        ' }',
      ].join('\n'),
    );
  });

  it('keeps far-apart changes in separate hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const b = a.replace('line 2\n', 'LINE 2\n').replace('line 19', 'LINE 19');
    const out = edgeDiff({ label: 'a', text: a }, { label: 'b', text: b }, 1)!;
    expect(out.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,3 +1,3 @@', '@@ -18,3 +18,3 @@']);
  });
});
