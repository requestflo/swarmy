import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { buildCaddyfile } from './caddyfile';

const COLD = { upstream: 'host.docker.internal:3001', wakePath: '/_wake/web' } as const;

function cfg(driver: string, partial: Record<string, unknown>): IngressConfig {
  return IngressConfigSchema.parse({ driver, orgId: 'org_1', domains: [], ...partial });
}

const WARM_AND_COLD = {
  domains: [
    { domain: 'app.example.com', service: 'web', port: 3000, tls: 'auto', cold: COLD },
    { domain: 'api.example.com', service: 'api', port: 8080, tls: 'off' },
  ],
};

describe('scale-to-zero cold routing', () => {
  it('caddy: cold domain rewrites to the activator with a return query; warm stays direct', () => {
    const out = buildCaddyfile(cfg('caddy', WARM_AND_COLD));
    expect(out).toContain('rewrite * /_wake/web?return={scheme}://{host}{uri}');
    expect(out).toContain('reverse_proxy host.docker.internal:3001');
    // cold domain must NOT proxy to the (asleep) service
    expect(out).not.toContain('reverse_proxy web:3000');
    // warm domain unchanged
    expect(out).toContain('reverse_proxy api:8080');
  });

  it('renders direct upstreams when no domain is cold (unchanged baseline)', () => {
    const warm = cfg('caddy', {
      domains: [{ domain: 'app.example.com', service: 'web', port: 3000, tls: 'auto' }],
    });
    const out = buildCaddyfile(warm);
    expect(out).toContain('reverse_proxy web:3000');
    expect(out).not.toContain('_wake');
  });
});
