import { describe, expect, it } from 'bun:test';
import { buildCaddyfile } from './render/caddyfile';
import { dnsGuidance } from './domain-verify';
import { CaddyDriver } from './drivers/caddy';
import { IngressConfigSchema } from './types';
import {
  ACME_DNS_TOKEN_FILE,
  BYO_DNS_TOKEN_FILE,
  challengeRecordName,
  checkChallengeName,
  isChallengeValue,
  planDnsChallenges,
  zoneFor,
} from './dns-challenge';

const route = (domain: string) => ({ domain, service: 'shop_web', port: 3000, tls: 'auto' as const });
const cfg = (partial: Record<string, unknown>) =>
  IngressConfigSchema.parse({ driver: 'caddy', orgId: 'org_1', ...partial });

describe('planDnsChallenges', () => {
  it('swarmy DNS for wildcards in a served zone, BYO for the rest, exact hosts untouched', () => {
    expect(
      planDnsChallenges({
        hosts: ['*.Acme.com', 'acme.com', '*.apps.acme.com', '*.other.io', '*.none.dev'],
        swarmyZones: ['acme.com'],
        byoProvider: null,
      }),
    ).toEqual({ hosts: { '*.acme.com': 'swarmy', '*.apps.acme.com': 'swarmy' }, unsolvable: ['*.none.dev', '*.other.io'] });
    expect(planDnsChallenges({ hosts: ['*.other.io'], swarmyZones: [], byoProvider: 'cloudflare' })).toEqual({
      hosts: { '*.other.io': 'cloudflare' },
      unsolvable: [],
    });
  });

  it('zoneFor picks the longest suffix; challenge name drops the wildcard', () => {
    expect(zoneFor('x.apps.acme.com', ['acme.com', 'apps.acme.com'])).toBe('apps.acme.com');
    expect(zoneFor('acme.community', ['acme.com'])).toBeNull();
    expect(challengeRecordName('*.acme.com')).toBe('_acme-challenge.acme.com');
  });
});

describe('Caddyfile DNS-01 render (golden)', () => {
  const dnsChallenge = {
    hosts: { '*.acme.com': 'swarmy', '*.other.io': 'cloudflare' },
    swarmy: { endpoint: 'http://swarmy_controller:3021/ingress/acme-dns/org_1', tokenFile: ACME_DNS_TOKEN_FILE },
    cloudflare: { tokenFile: BYO_DNS_TOKEN_FILE },
  };
  const out = buildCaddyfile(
    cfg({ domains: [route('*.acme.com'), route('*.other.io'), route('app.acme.com')], dnsChallenge }),
  );

  it('swarmy provider: endpoint + token file, never a token', () => {
    expect(out).toContain(
      [
        '*.acme.com {',
        '  tls {',
        '    dns swarmy {',
        '      endpoint http://swarmy_controller:3021/ingress/acme-dns/org_1',
        '      token_file /run/secrets/swarmy-acme-dns',
        '    }',
        '    propagation_timeout 3m',
        '  }',
      ].join('\n'),
    );
  });

  it('BYO cloudflare: the token comes from a {file.*} placeholder', () => {
    expect(out).toContain('*.other.io {\n  tls {\n    dns cloudflare {file./run/secrets/swarmy-acme-dns-byo}\n  }');
  });

  it('exact hosts keep plain automatic HTTPS', () => {
    expect(out).toMatch(/app\.acme\.com \{\n(?!  tls)/);
  });

  it('no dnsChallenge → byte-identical to before', () => {
    const plain = cfg({ domains: [route('app.acme.com')] });
    expect(buildCaddyfile(cfg({ domains: [route('app.acme.com')], dnsChallenge: { hosts: {} } }))).toBe(buildCaddyfile(plain));
  });

  it('beats on-demand TLS for the wildcard site', () => {
    const od = buildCaddyfile(
      cfg({ domains: [route('*.acme.com')], dnsChallenge, globalOptions: { onDemandTls: true, email: 'a@b.co' } }),
    );
    expect(od).toContain('*.acme.com {\n  tls {\n    dns swarmy {');
    expect(od).not.toContain('*.acme.com {\n  tls {\n    on_demand');
  });
});

describe('caddy validate', () => {
  it('warns on a wildcard nobody can solve; errors on DNS-01 with the stock image', () => {
    const d = new CaddyDriver();
    const warn = d.validate(cfg({ domains: [route('*.acme.com')] }));
    expect(warn.warnings?.some((w) => w.path === 'dnsChallenge' && w.message.includes('*.acme.com'))).toBe(true);
    const stock = d.validate(
      cfg({
        domains: [route('*.acme.com')],
        dnsChallenge: { hosts: { '*.acme.com': 'swarmy' }, swarmy: { endpoint: 'http://c/x', tokenFile: '/t' } },
        globalOptions: { extraConfig: { controllerImage: 'caddy:2-alpine' } },
      }),
    );
    expect(stock.ok).toBe(false);
  });
});

describe('checkChallengeName', () => {
  const base = { routedHosts: ['*.acme.com', 'shop.acme.com', 'x.foreign.io'], zones: ['acme.com'] };
  it('accepts _acme-challenge for a routed wildcard / host inside a swarmy zone', () => {
    expect(checkChallengeName({ ...base, fqdn: '_acme-challenge.acme.com.' })).toEqual({
      ok: true,
      base: 'acme.com',
      zone: 'acme.com',
      relName: '_acme-challenge',
    });
    expect(checkChallengeName({ ...base, fqdn: '_acme-challenge.shop.acme.com' })).toMatchObject({
      ok: true,
      relName: '_acme-challenge.shop',
    });
  });
  it('refuses anything else', () => {
    expect(checkChallengeName({ ...base, fqdn: 'acme.com' })).toMatchObject({ ok: false, status: 400 });
    expect(checkChallengeName({ ...base, fqdn: '_acme-challenge.evil.acme.com' })).toMatchObject({ ok: false, status: 403 });
    expect(checkChallengeName({ ...base, fqdn: '_acme-challenge.x.foreign.io' })).toMatchObject({ ok: false, status: 403 });
    expect(checkChallengeName({ ...base, fqdn: '_acme-challenge.*.acme.com' })).toMatchObject({ ok: false, status: 400 });
  });
  it('challenge values are base64url digests only', () => {
    expect(isChallengeValue('LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0')).toBe(true);
    expect(isChallengeValue('"quoted" value')).toBe(false);
    expect(isChallengeValue(42)).toBe(false);
  });
});

describe('dnsGuidance wildcard note', () => {

  const expected = { ips: ['203.0.113.10'] };
  it('swarmy DNS: NS delegation records + no provider needed', () => {
    const g = dnsGuidance({
      host: '*.acme.com',
      expected,
      zone: { zone: 'acme.com', nameservers: [{ fqdn: 'ns1.acme.com', ip: '203.0.113.10' }] },
      dnsChallenge: 'swarmy',
    });
    expect(g.mode).toBe('zone');
    expect(g.records[0]).toMatchObject({ type: 'NS', name: 'acme.com', value: 'ns1.acme.com' });
    expect(g.wildcard?.provider).toBe('swarmy');
    expect(g.wildcard?.summary).toContain('_acme-challenge.acme.com');
  });
  it('nobody can solve it: says how', () => {
    const g = dnsGuidance({ host: '*.acme.com', expected, dnsChallenge: null });
    expect(g.wildcard).toMatchObject({ provider: null });
    expect(g.wildcard?.summary).toContain('point its NS records at swarmy');
  });
  it('exact hosts carry no wildcard note', () => {
    expect(dnsGuidance({ host: 'app.acme.com', expected }).wildcard).toBeUndefined();
  });
});
