import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { buildNginxConfig } from './nginx';
import { buildHaproxyConfig } from './haproxy';

function cfg(partial: Record<string, unknown>): IngressConfig {
  return IngressConfigSchema.parse({
    driver: 'nginx',
    orgId: 'org_1',
    domains: [],
    ...partial,
  });
}

const BASE = cfg({
  domains: [
    { domain: 'app.example.com', service: 'web', port: 3000, tls: 'auto' },
    { domain: 'api.example.com', service: 'api', port: 8080, tls: 'off' },
    {
      domain: 'docs.example.com',
      service: 'docs',
      port: 4000,
      tls: 'auto',
      pathPrefix: '/guide',
      stripPathPrefix: true,
    },
  ],
});

describe('nginx render (golden)', () => {
  it('renders deterministic server blocks', () => {
    const out = buildNginxConfig(BASE);
    expect(out).toContain('server_name app.example.com;');
    expect(out).toContain('listen 443 ssl;');
    expect(out).toContain('ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;');
    expect(out).toContain('proxy_pass http://web:3000;');
    // tls:off → plain :80
    expect(out).toContain('listen 80;');
    expect(out).toContain('proxy_pass http://api:8080;');
    // strip-path-prefix → trailing-slash proxy_pass + location prefix
    expect(out).toContain('location /guide {');
    expect(out).toContain('proxy_pass http://docs:4000/;');
    // forwarded headers always present
    expect(out).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
    // stable across calls
    expect(buildNginxConfig(BASE)).toBe(out);
  });

  it('honors custom cert material', () => {
    const c = cfg({
      domains: [{ domain: 'c.example.com', service: 'web', port: 80, tls: 'custom' }],
      globalOptions: {
        extraConfig: { certs: { 'c.example.com': { cert: '/c/crt.pem', key: '/c/key.pem' } } },
      },
    });
    const out = buildNginxConfig(c);
    expect(out).toContain('ssl_certificate /c/crt.pem;');
    expect(out).toContain('ssl_certificate_key /c/key.pem;');
  });

  it('renders nothing meaningful with no domains', () => {
    expect(buildNginxConfig(cfg({ domains: [] })).trim()).toBe('');
  });
});

describe('haproxy render (golden)', () => {
  it('renders frontends, SNI routing, and a backend per domain', () => {
    const out = buildHaproxyConfig(BASE);
    expect(out).toContain('frontend https_in');
    expect(out).toContain('bind *:443 ssl crt /etc/haproxy/certs');
    expect(out).toContain('use_backend be_app_example_com if { ssl_fc_sni -i app.example.com }');
    // plain HTTP frontend for tls:off
    expect(out).toContain('frontend http_in');
    expect(out).toContain('use_backend be_api_example_com if { hdr(host) -i api.example.com }');
    // backend wiring
    expect(out).toContain('backend be_app_example_com');
    expect(out).toContain('server srv web:3000');
    expect(out).toContain('server srv api:8080');
    // strip-prefix → replace-path
    expect(out).toContain('http-request replace-path /guide(.*) \\1');
    // stable across calls
    expect(buildHaproxyConfig(BASE)).toBe(out);
  });

  it('omits the https frontend when every domain is plain HTTP', () => {
    const c = cfg({ domains: [{ domain: 'p.example.com', service: 'web', port: 80, tls: 'off' }] });
    const out = buildHaproxyConfig(c);
    expect(out).not.toContain('frontend https_in');
    expect(out).toContain('frontend http_in');
  });
});
