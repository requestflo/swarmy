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

describe('caddy route protections — rate limit, IP rules, body cap, bots, headers', () => {
  it('GOLDEN: a fully-protected root route renders every protection before the proxy', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'api.xyz.com',
          service: 'api',
          port: 8080,
          pathPrefix: '/',
          tls: 'auto',
          protection: {
            rateLimit: { requests: 100, windowSeconds: 60, key: 'ip' },
            ipAllow: ['10.0.0.0/8', '192.168.1.0/24'],
            ipDeny: ['203.0.113.7'],
            bodyMaxSize: '10MB',
            blockBots: true,
            requiredHeaders: [{ name: 'X-Api-Key' }, { name: 'X-Env', value: 'prod' }],
          },
        },
      ]),
    );
    expect(out).toBe(
      [
        'api.xyz.com {',
        '  @deny_api_xyz_com remote_ip 203.0.113.7',
        '  abort @deny_api_xyz_com',
        '  @notallowed_api_xyz_com {',
        '    not remote_ip 10.0.0.0/8 192.168.1.0/24',
        '  }',
        '  abort @notallowed_api_xyz_com',
        '  @bots_api_xyz_com header_regexp User-Agent (?i)(bot|crawler|spider|scan)',
        '  abort @bots_api_xyz_com',
        '  @nohdr0_api_xyz_com {',
        '    not header X-Api-Key *',
        '  }',
        '  abort @nohdr0_api_xyz_com',
        '  @nohdr1_api_xyz_com {',
        '    not header X-Env prod',
        '  }',
        '  abort @nohdr1_api_xyz_com',
        '  request_body {',
        '    max_size 10MB',
        '  }',
        '  rate_limit {',
        '    zone rl_api_xyz_com {',
        '      key {remote_host}',
        '      events 100',
        '      window 60s',
        '    }',
        '  }',
        '  reverse_proxy api:8080',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('rate limit keyed by a header uses the {header.X} placeholder', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'api.xyz.com',
          service: 'api',
          port: 8080,
          pathPrefix: '/',
          tls: 'auto',
          protection: { rateLimit: { requests: 30, windowSeconds: 10, key: 'header', header: 'X-Api-Key' } },
        },
      ]),
    );
    expect(out).toContain('key {header.X-Api-Key}');
    expect(out).toContain('events 30');
    expect(out).toContain('window 10s');
  });

  it('protections nest inside the route handle, before its proxy, and never leak to siblings', () => {
    const out = buildCaddyfile(
      cfg([
        { domain: 'xyz.com', service: 'web', port: 3000, pathPrefix: '/', tls: 'auto' },
        {
          domain: 'xyz.com',
          service: 'api',
          port: 8080,
          pathPrefix: '/api',
          tls: 'auto',
          protection: { ipDeny: ['198.51.100.0/24'], blockBots: true },
        },
      ]),
    );
    const block = siteBlock(out, 'xyz.com');
    const handleIdx = block.findIndex((l) => l.includes('handle /api* {'));
    const denyIdx = block.findIndex((l) => l.includes('@deny_xyz_com_api remote_ip 198.51.100.0/24'));
    const proxyIdx = block.findIndex((l) => l.includes('reverse_proxy api:8080'));
    const rootIdx = block.findIndex((l) => l.trim() === 'handle {');
    expect(denyIdx).toBeGreaterThan(handleIdx);
    expect(denyIdx).toBeLessThan(proxyIdx);
    // The unprotected root catch-all carries no matchers.
    expect(rootIdx).toBeGreaterThan(proxyIdx);
    expect(block.filter((l) => l.includes('abort')).length).toBe(2); // deny + bots only
  });

  it('a cold protected route aborts BEFORE the wake rewrite (a blocked request never wakes the service)', () => {
    const out = buildCaddyfile(
      cfg([
        {
          domain: 'app.xyz.com',
          service: 'web',
          port: 3000,
          pathPrefix: '/',
          tls: 'auto',
          cold: { upstream: 'host.docker.internal:3001', wakePath: '/_wake/web' },
          protection: { ipDeny: ['203.0.113.7'] },
        },
      ]),
    );
    const block = siteBlock(out, 'app.xyz.com');
    const abortIdx = block.findIndex((l) => l.includes('abort @deny_app_xyz_com'));
    const wakeIdx = block.findIndex((l) => l.includes('rewrite * /_wake/web'));
    expect(abortIdx).toBeGreaterThanOrEqual(0);
    expect(abortIdx).toBeLessThan(wakeIdx);
  });

  it('a route without protection renders byte-for-byte as before (no matchers, no rate_limit)', () => {
    const out = buildCaddyfile(
      cfg([{ domain: 'solo.xyz.com', service: 'web', port: 3000, pathPrefix: '/', tls: 'auto' }]),
    );
    expect(out).toBe(['solo.xyz.com {', '  reverse_proxy web:3000', '}', ''].join('\n'));
  });
});

describe('caddy controller vhosts — status pages / webhooks / AI gateway domains', () => {
  it('GOLDEN: a status-page vhost rewrites onto the controller slug path', () => {
    const out = buildCaddyfile(
      IngressConfigSchema.parse({
        driver: 'caddy',
        orgId: 'org_1',
        domains: [],
        controllerVhosts: [
          {
            domain: 'status.xyz.com',
            upstream: 'host.docker.internal:3001',
            targetPath: '/s/my-page',
            kind: 'status-page',
          },
        ],
      }),
    );
    expect(out).toBe(
      [
        'status.xyz.com {',
        '  # swarmy status-page vhost',
        '  @spa not path /assets/*',
        '  rewrite @spa /s/my-page{uri}',
        '  reverse_proxy host.docker.internal:3001',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('GOLDEN: an ai-gateway vhost rewrites the whole path space onto /ai', () => {
    const out = buildCaddyfile(
      IngressConfigSchema.parse({
        driver: 'caddy',
        orgId: 'org_1',
        domains: [],
        controllerVhosts: [
          {
            domain: 'ai.xyz.com',
            upstream: 'host.docker.internal:3001',
            targetPath: '/ai',
            kind: 'ai-gateway',
          },
        ],
      }),
    );
    expect(out).toBe(
      [
        'ai.xyz.com {',
        '  # swarmy ai-gateway vhost',
        '  rewrite * /ai{uri}',
        '  reverse_proxy host.docker.internal:3001',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('a webhook vhost with tls off serves plain http', () => {
    const out = buildCaddyfile(
      IngressConfigSchema.parse({
        driver: 'caddy',
        orgId: 'org_1',
        domains: [],
        controllerVhosts: [
          {
            domain: 'hooks.xyz.com',
            upstream: 'host.docker.internal:3001',
            targetPath: '/hooks/i/org_1/gh',
            kind: 'webhook',
            tls: 'off',
          },
        ],
      }),
    );
    expect(out).toContain('http://hooks.xyz.com {');
    expect(out).toContain('rewrite * /hooks/i/org_1/gh{uri}');
  });

  it('a vhost whose domain already has a service route is skipped (no duplicate site address)', () => {
    const out = buildCaddyfile(
      IngressConfigSchema.parse({
        driver: 'caddy',
        orgId: 'org_1',
        domains: [{ domain: 'app.xyz.com', service: 'web', port: 3000 }],
        controllerVhosts: [
          {
            domain: 'app.xyz.com',
            upstream: 'host.docker.internal:3001',
            targetPath: '/s/app',
            kind: 'status-page',
          },
          {
            domain: 'status.xyz.com',
            upstream: 'host.docker.internal:3001',
            targetPath: '/s/app',
            kind: 'status-page',
          },
        ],
      }),
    );
    expect(out.match(/^app\.xyz\.com \{$/gm)?.length).toBe(1);
    expect(out).toContain('reverse_proxy web:3000');
    expect(out).toContain('status.xyz.com {');
  });

  it('vhosts render after the service route sites, one block per domain', () => {
    const out = buildCaddyfile(
      IngressConfigSchema.parse({
        driver: 'caddy',
        orgId: 'org_1',
        domains: [{ domain: 'app.xyz.com', service: 'web', port: 3000 }],
        controllerVhosts: [
          {
            domain: 'status.xyz.com',
            upstream: 'host.docker.internal:3001',
            targetPath: '/s/app',
            kind: 'status-page',
          },
        ],
      }),
    );
    expect(out.indexOf('app.xyz.com {')).toBeLessThan(out.indexOf('status.xyz.com {'));
  });
});
