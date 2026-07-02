import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { buildCaddyfile } from './caddyfile';

function cfg(domains: Record<string, unknown>[], globalOptions: Record<string, unknown> = {}): IngressConfig {
  return IngressConfigSchema.parse({ driver: 'caddy', orgId: 'org_1', domains, globalOptions });
}

/** Extract the body lines of the `host { … }` site block (for ordering assertions). */
function siteBlock(caddyfile: string, address: string): string[] {
  const lines = caddyfile.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${address} {`);
  if (start < 0) throw new Error(`no site block for ${address} in:\n${caddyfile}`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === '}') break;
    body.push(line);
  }
  return body;
}

describe('caddy host grouping — path routing across services', () => {
  it('two services on ONE host, different paths → a single site block, longest prefix first', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'xyz.com', service: 'appA', port: 3000, pathPrefix: '/app', tls: 'auto' },
        { domain: 'xyz.com', service: 'appB', port: 8080, pathPrefix: '/app/api', tls: 'auto' },
      ]),
    );

    // Exactly ONE site block for the host (Caddy rejects duplicate site addresses).
    expect(out.match(/^xyz\.com \{$/gm)?.length).toBe(1);

    const block = siteBlock(out, 'xyz.com');
    const apiIdx = block.findIndex((l) => l.includes('handle /app/api* {'));
    const appIdx = block.findIndex((l) => l.includes('handle /app* {'));
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(appIdx).toBeGreaterThanOrEqual(0);
    // Most-specific path (longest prefix) must be emitted FIRST so Caddy matches it.
    expect(apiIdx).toBeLessThan(appIdx);
    expect(out).toContain('reverse_proxy appB:8080');
    expect(out).toContain('reverse_proxy appA:3000');
  });

  it('a root route on a multi-route host renders as the trailing catch-all handle', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'xyz.com', service: 'web', port: 3000, pathPrefix: '/', tls: 'auto' },
        { domain: 'xyz.com', service: 'api', port: 8080, pathPrefix: '/api', tls: 'auto' },
      ]),
    );
    const block = siteBlock(out, 'xyz.com');
    const apiIdx = block.findIndex((l) => l.includes('handle /api* {'));
    const rootIdx = block.findIndex((l) => l.trim() === 'handle {');
    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    // The path handle precedes the bare catch-all `handle {`.
    expect(apiIdx).toBeLessThan(rootIdx);
  });

  it('ws + http share one host: both proxied from a single block (Caddy auto-upgrades ws)', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'live.xyz.com', service: 'web', port: 3000, pathPrefix: '/', tls: 'auto' },
        { domain: 'live.xyz.com', service: 'ws', port: 9000, pathPrefix: '/ws', tls: 'auto' },
      ]),
    );
    expect(out.match(/^live\.xyz\.com \{$/gm)?.length).toBe(1);
    const block = siteBlock(out, 'live.xyz.com');
    const wsIdx = block.findIndex((l) => l.includes('handle /ws* {'));
    const rootIdx = block.findIndex((l) => l.trim() === 'handle {');
    expect(wsIdx).toBeLessThan(rootIdx); // /ws is more specific than the root
    expect(out).toContain('reverse_proxy ws:9000');
    expect(out).toContain('reverse_proxy web:3000');
  });

  it('path strip: stripPrefix uses handle_path; without it uses handle', () => {
    const stripped = buildCaddyfile(
      cfg([
        { domain: 'xyz.com', service: 'appA', port: 3000, pathPrefix: '/app', stripPathPrefix: true, tls: 'auto' },
        { domain: 'xyz.com', service: 'appB', port: 8080, pathPrefix: '/api', stripPathPrefix: false, tls: 'auto' },
      ]),
    );
    expect(stripped).toContain('handle_path /app* {');
    expect(stripped).toContain('handle /api* {');
    expect(stripped).not.toContain('handle_path /api* {');
  });

  it('mixed cold + warm on one host: only the cold path diverts to the activator', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'xyz.com', service: 'web', port: 3000, pathPrefix: '/', tls: 'auto' },
        {
          domain: 'xyz.com',
          service: 'api',
          port: 8080,
          pathPrefix: '/api',
          tls: 'auto',
          cold: { upstream: 'host.docker.internal:3001', wakePath: '/_wake/api' },
        },
      ]),
    );
    expect(out.match(/^xyz\.com \{$/gm)?.length).toBe(1);
    // The cold /api path wakes via the activator…
    expect(out).toContain('rewrite * /_wake/api?return={scheme}://{host}{uri}');
    expect(out).toContain('reverse_proxy host.docker.internal:3001');
    // …while the warm root stays a direct upstream (NOT sent to the activator).
    expect(out).toContain('reverse_proxy web:3000');
  });

  it('TLS per host: any `off`-only host serves http://; a custom cert governs the host', () => {
    const offOnly = buildCaddyfile(
      cfg([
        { domain: 'plain.xyz.com', service: 'a', port: 3000, pathPrefix: '/', tls: 'off' },
        { domain: 'plain.xyz.com', service: 'b', port: 8080, pathPrefix: '/b', tls: 'off' },
      ]),
    );
    expect(offOnly).toContain('http://plain.xyz.com {');
    expect(offOnly.match(/^plain\.xyz\.com \{$/gm)).toBeNull();

    const customCert = buildCaddyfile(
      cfg(
        [
          { domain: 'sec.xyz.com', service: 'a', port: 3000, pathPrefix: '/', tls: 'custom' },
          { domain: 'sec.xyz.com', service: 'b', port: 8080, pathPrefix: '/b', tls: 'auto' },
        ],
        { extraConfig: { certs: { 'sec.xyz.com': { cert: '/c.pem', key: '/k.pem' } } } },
      ),
    );
    expect(customCert).toContain('tls /c.pem /k.pem');
  });

  it('single-service host at the root is unchanged: a bare reverse_proxy, no handle wrapper', () => {
    const out = buildCaddyfile(
      cfg([{ domain: 'solo.xyz.com', service: 'web', port: 3000, pathPrefix: '/', tls: 'auto' }]),
    );
    const block = siteBlock(out, 'solo.xyz.com');
    expect(block).toContain('  reverse_proxy web:3000');
    expect(out).not.toContain('handle');
  });
});

describe('caddy canary — weighted upstreams (D2)', () => {
  it('GOLDEN: a root route with a 10% canary renders both upstreams + positional weights', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'app.xyz.com',
          service: 'web',
          port: 3000,
          pathPrefix: '/',
          tls: 'auto',
          canary: { service: 'web--canary', port: 3000, weightPct: 10 },
        },
      ]),
    );
    // Exact block, byte-for-byte: stable upstream FIRST, canary second, and the
    // weighted_round_robin weights in THE SAME order (90 stable, 10 canary).
    expect(out).toBe(
      [
        'app.xyz.com {',
        '  reverse_proxy web:3000 web--canary:3000 {',
        '    lb_policy weighted_round_robin 90 10',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('GOLDEN: a path route with a canary nests the weighted proxy inside its handle', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'xyz.com', service: 'web', port: 3000, pathPrefix: '/', tls: 'auto' },
        {
          domain: 'xyz.com',
          service: 'api',
          port: 8080,
          pathPrefix: '/api',
          tls: 'auto',
          canary: { service: 'api--canary', port: 8080, weightPct: 25 },
        },
      ]),
    );
    expect(out).toBe(
      [
        'xyz.com {',
        '  handle /api* {',
        '    reverse_proxy api:8080 api--canary:8080 {',
        '      lb_policy weighted_round_robin 75 25',
        '    }',
        '  }',
        '  handle {',
        '    reverse_proxy web:3000',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('weights are clamped + rounded to integers (weighted_round_robin takes ints)', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'app.xyz.com',
          service: 'web',
          port: 3000,
          pathPrefix: '/',
          tls: 'auto',
          canary: { service: 'web--canary', port: 3000, weightPct: 33.4 },
        },
      ]),
    );
    expect(out).toContain('lb_policy weighted_round_robin 67 33');
  });

  it('a 0% canary renders as a plain single-upstream proxy (no lb_policy)', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'app.xyz.com',
          service: 'web',
          port: 3000,
          pathPrefix: '/',
          tls: 'auto',
          canary: { service: 'web--canary', port: 3000, weightPct: 0 },
        },
      ]),
    );
    expect(out).toContain('  reverse_proxy web:3000');
    expect(out).not.toContain('weighted_round_robin');
    expect(out).not.toContain('web--canary');
  });

  it('a cold route ignores its canary: waking the stable service wins', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'app.xyz.com',
          service: 'web',
          port: 3000,
          pathPrefix: '/',
          tls: 'auto',
          cold: { upstream: 'host.docker.internal:3001', wakePath: '/_wake/web' },
          canary: { service: 'web--canary', port: 3000, weightPct: 10 },
        },
      ]),
    );
    expect(out).toContain('rewrite * /_wake/web?return={scheme}://{host}{uri}');
    expect(out).toContain('reverse_proxy host.docker.internal:3001');
    expect(out).not.toContain('weighted_round_robin');
  });

  it('sibling routes on the same host stay single-upstream when only one has a canary', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'xyz.com',
          service: 'web',
          port: 3000,
          pathPrefix: '/',
          tls: 'auto',
          canary: { service: 'web--canary', port: 3000, weightPct: 50 },
        },
        { domain: 'xyz.com', service: 'api', port: 8080, pathPrefix: '/api', tls: 'auto' },
      ]),
    );
    expect(out).toContain('reverse_proxy web:3000 web--canary:3000 {');
    expect(out).toContain('lb_policy weighted_round_robin 50 50');
    expect(out).toContain('reverse_proxy api:8080');
    expect(out).not.toContain('api--canary');
  });
});
