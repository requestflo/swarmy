import { describe, expect, it } from 'bun:test';
import { IngressConfigSchema, type IngressConfig } from '../types';
import { buildNginxConfig } from './nginx';
import { buildHaproxyConfig } from './haproxy';
import { buildTraefikDynamicYaml, buildTraefikLabels } from './traefik-labels';

/**
 * Apex ↔ www `hostRedirects` for the non-Caddy drivers — goldens. Same
 * contract as the Caddy renderer (www.test.ts): a 308 with path + query kept,
 * the redirect host carries its own TLS, an explicit route for `from` wins,
 * and an empty/absent list is byte-identical to the plain render.
 */
function cfg(partial: Record<string, unknown>): IngressConfig {
  return IngressConfigSchema.parse({ driver: 'nginx', orgId: 'org_1', domains: [], ...partial });
}

const DOMAINS = [
  { domain: 'acme.com', service: 'shop_web', port: 3000, tls: 'auto' },
  { domain: 'plain.dev', service: 'shop_web', port: 3000, tls: 'off' },
];
const REDIRECTS = [
  { from: 'www.acme.com', to: 'acme.com', tls: 'auto' },
  { from: 'www.plain.dev', to: 'plain.dev', tls: 'off' },
  // explicit route for the same host wins → skipped
  { from: 'plain.dev', to: 'www.plain.dev', tls: 'off' },
];
const WITH = cfg({ domains: DOMAINS, hostRedirects: REDIRECTS });

describe('nginx hostRedirects', () => {
  it('no redirects → byte-identical', () => {
    expect(buildNginxConfig(cfg({ domains: DOMAINS, hostRedirects: [] }))).toBe(buildNginxConfig(cfg({ domains: DOMAINS })));
  });
  it('golden', () => {
    const out = buildNginxConfig(WITH);
    expect(out.slice(out.indexOf('server {\n  listen 443 ssl;\n  server_name www.acme.com;'))).toBe(
      [
        'server {',
        '  listen 443 ssl;',
        '  server_name www.acme.com;',
        '  ssl_certificate /etc/letsencrypt/live/www.acme.com/fullchain.pem;',
        '  ssl_certificate_key /etc/letsencrypt/live/www.acme.com/privkey.pem;',
        '  # swarmy www redirect',
        '  return 308 https://acme.com$request_uri;',
        '}',
        '',
        'server {',
        '  listen 80;',
        '  server_name www.plain.dev;',
        '  # swarmy www redirect',
        '  return 308 http://plain.dev$request_uri;',
        '}',
        '',
      ].join('\n'),
    );
    expect(out.match(/server_name plain\.dev;/g)).toHaveLength(1);
  });
  it('custom tls uses the redirect host’s own material when supplied', () => {
    const out = buildNginxConfig(
      cfg({
        hostRedirects: [{ from: 'www.c.com', to: 'c.com', tls: 'custom' }],
        globalOptions: { extraConfig: { certs: { 'www.c.com': { cert: '/w/crt', key: '/w/key' } } } },
      }),
    );
    expect(out).toContain('ssl_certificate /w/crt;');
  });
});

describe('haproxy hostRedirects', () => {
  it('no redirects → byte-identical', () => {
    expect(buildHaproxyConfig(cfg({ domains: DOMAINS, hostRedirects: [] }))).toBe(buildHaproxyConfig(cfg({ domains: DOMAINS })));
  });
  it('golden frontends', () => {
    const out = buildHaproxyConfig(WITH);
    expect(out).toContain(
      [
        'frontend http_in',
        '  bind *:80',
        '  http-request redirect prefix http://plain.dev code 308 if { hdr(host) -i www.plain.dev }',
        '  use_backend be_plain_dev if { hdr(host) -i plain.dev }',
        '',
        'frontend https_in',
        '  bind *:443 ssl crt /etc/haproxy/certs',
        '  http-request set-header X-Forwarded-Proto https',
        '  http-request redirect prefix https://acme.com code 308 if { ssl_fc_sni -i www.acme.com }',
        '  use_backend be_acme_com if { ssl_fc_sni -i acme.com }',
        '',
      ].join('\n'),
    );
    expect(out).not.toContain('backend be_www');
  });
  it('a redirect alone opens its frontend', () => {
    const out = buildHaproxyConfig(cfg({ hostRedirects: [{ from: 'www.a.com', to: 'a.com', tls: 'auto' }] }));
    expect(out).toContain('frontend https_in');
    expect(out).not.toContain('frontend http_in');
  });
});

describe('traefik hostRedirects', () => {
  it('no redirects → identical labels + yaml', () => {
    const plain = cfg({ domains: DOMAINS });
    const empty = cfg({ domains: DOMAINS, hostRedirects: [] });
    expect(buildTraefikDynamicYaml(empty)).toBe(buildTraefikDynamicYaml(plain));
    expect([...buildTraefikLabels(empty)]).toEqual([...buildTraefikLabels(plain)]);
  });
  it('golden labels ride on the canonical host’s service', () => {
    const labels = buildTraefikLabels(WITH).get('shop_web')!;
    const redirect = Object.fromEntries(Object.entries(labels).filter(([k]) => k.includes('www-redirect')));
    expect(redirect).toEqual({
      'traefik.http.routers.www-redirect-www-acme-com.rule': 'Host(`www.acme.com`)',
      'traefik.http.routers.www-redirect-www-acme-com.entrypoints': 'websecure',
      'traefik.http.routers.www-redirect-www-acme-com.tls.certresolver': 'le',
      'traefik.http.routers.www-redirect-www-acme-com.service': 'noop@internal',
      'traefik.http.routers.www-redirect-www-acme-com.middlewares': 'www-redirect-www-acme-com',
      'traefik.http.middlewares.www-redirect-www-acme-com.redirectregex.regex': '^https?://www\\.acme\\.com(:[0-9]+)?(.*)$',
      'traefik.http.middlewares.www-redirect-www-acme-com.redirectregex.replacement': 'https://acme.com${2}',
      'traefik.http.middlewares.www-redirect-www-acme-com.redirectregex.permanent': 'true',
      'traefik.http.routers.www-redirect-www-plain-dev.rule': 'Host(`www.plain.dev`)',
      'traefik.http.routers.www-redirect-www-plain-dev.entrypoints': 'web',
      'traefik.http.routers.www-redirect-www-plain-dev.service': 'noop@internal',
      'traefik.http.routers.www-redirect-www-plain-dev.middlewares': 'www-redirect-www-plain-dev',
      'traefik.http.middlewares.www-redirect-www-plain-dev.redirectregex.regex': '^https?://www\\.plain\\.dev(:[0-9]+)?(.*)$',
      'traefik.http.middlewares.www-redirect-www-plain-dev.redirectregex.replacement': 'http://plain.dev${2}',
      'traefik.http.middlewares.www-redirect-www-plain-dev.redirectregex.permanent': 'true',
    });
    // The regex really matches what Traefik feeds it (scheme://host[:port]/path?query).
    const re = new RegExp(redirect['traefik.http.middlewares.www-redirect-www-acme-com.redirectregex.regex']!);
    expect('https://www.acme.com/a/b?c=1'.replace(re, 'https://acme.com$2')).toBe('https://acme.com/a/b?c=1');
    expect(re.test('https://wwwxacme.com/')).toBe(false);
  });
  it('golden file-provider yaml', () => {
    const y = buildTraefikDynamicYaml(cfg({ domains: [DOMAINS[0]], hostRedirects: [REDIRECTS[0]] }));
    expect(y).toContain(
      [
        '    www-redirect-www-acme-com:',
        '      rule: "Host(`www.acme.com`)"',
        '      service: "noop@internal"',
        '      entryPoints: ["websecure"]',
        '      middlewares: ["www-redirect-www-acme-com"]',
        '      tls:',
        '        certResolver: le',
        '  services:',
      ].join('\n'),
    );
    expect(y).toContain(
      [
        '  middlewares:',
        '    www-redirect-www-acme-com:',
        '      redirectRegex:',
        "        regex: '^https?://www\\.acme\\.com(:[0-9]+)?(.*)$'",
        "        replacement: 'https://acme.com${2}'",
        '        permanent: true',
        '',
      ].join('\n'),
    );
  });
  it('a redirect whose destination has no route here is skipped in labels mode', () => {
    expect(buildTraefikLabels(cfg({ hostRedirects: [REDIRECTS[0]] })).size).toBe(0);
  });
});
