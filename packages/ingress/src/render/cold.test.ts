import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { buildCaddyfile } from './caddyfile';
import { buildNginxConfig } from './nginx';
import { buildHaproxyConfig } from './haproxy';
import { buildTraefikDynamicYaml } from './traefik-labels';

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

  it('nginx: cold domain rewrites to the wake path then proxies the activator host', () => {
    const out = buildNginxConfig(cfg('nginx', WARM_AND_COLD));
    expect(out).toContain('rewrite ^ /_wake/web?return=$scheme://$host$request_uri break;');
    expect(out).toContain('proxy_pass http://host.docker.internal:3001;');
    expect(out).not.toContain('proxy_pass http://web:3000;');
    expect(out).toContain('proxy_pass http://api:8080;');
  });

  it('haproxy: cold backend sets the wake path and dials the activator', () => {
    const out = buildHaproxyConfig(cfg('haproxy', WARM_AND_COLD));
    expect(out).toContain('http-request set-path /_wake/web');
    expect(out).toContain('server srv host.docker.internal:3001');
    expect(out).not.toContain('server srv web:3000');
    expect(out).toContain('server srv api:8080');
  });

  it('traefik (file provider): cold service points at the activator via a replacePath middleware', () => {
    const out = buildTraefikDynamicYaml(cfg('traefik', WARM_AND_COLD));
    expect(out).toContain('middlewares:');
    expect(out).toContain('replacePath:');
    expect(out).toContain('path: "/_wake/web"');
    expect(out).toContain('url: "http://host.docker.internal:3001"');
    // warm service keeps its direct upstream
    expect(out).toContain('url: "http://api:8080"');
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
