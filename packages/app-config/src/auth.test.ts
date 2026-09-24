import { describe, expect, it } from 'bun:test';
import { parseAppConfig } from './parse';
import { toDesired } from './desired';
import { APP_AUTH_IMAGE, AUTH_UNIT } from './auth';

const YAML = (auth: string, extra = '') => `version: 1
app: shop
services:
  web:
    image: nginx:1.27
    port: 80
    domains: [shop.example.com, { host: www.shop.example.com }]
${extra}auth:
${auth}`;

function desired(text: string) {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return { d: toDesired(r.config), issues: r.issues };
}

describe('auth: (end-user sign-in resource)', () => {
  it('adds one swarmy-auth service on a SQLite volume, /auth/ on every host, and SWARMY_AUTH_URL everywhere', () => {
    const { d } = desired(YAML('  providers: [github, google]\n  email: magic-link\n  allowedDomains: [acme.com]\n'));
    const auth = d.services.find((s) => s.name === AUTH_UNIT)!;
    expect(auth.serviceName).toBe('shop_swarmy-auth');
    expect(auth.source).toEqual({ kind: 'image', image: APP_AUTH_IMAGE });
    expect(auth.env).toMatchObject({
      AUTH_BASE_PATH: '/auth',
      AUTH_PROVIDERS: 'github,google',
      AUTH_EMAIL: 'magic-link',
      AUTH_ALLOWED_DOMAINS: 'acme.com',
      AUTH_HOSTS: 'shop.example.com,www.shop.example.com',
      AUTH_SQLITE_PATH: '/data/auth.sqlite',
      SWARMY_STACK: 'shop',
    });
    expect(auth.bindings).toContain('app.url');
    expect(auth.secrets).toEqual([
      'auth-github-client-id',
      'auth-github-client-secret',
      'auth-google-client-id',
      'auth-google-client-secret',
    ]);
    expect(auth.volumes).toEqual([{ name: 'data', volumeName: 'shop_swarmy-auth-data', target: '/data' }]);
    expect(d.routes.filter((r) => r.service === AUTH_UNIT).map((r) => `${r.host}${r.path}`)).toEqual([
      'shop.example.com/auth/',
      'www.shop.example.com/auth/',
    ]);
    expect(d.services.find((s) => s.name === 'web')!.env.SWARMY_AUTH_URL).toBe('http://shop_swarmy-auth:3000');
  });

  it('uses the app’s managed Postgres when it has one (no volume)', () => {
    const { d } = desired(YAML('  providers: [microsoft]\n  microsoft: { tenant: acme-tenant }\n', 'resources:\n  db: postgres\n'));
    const auth = d.services.find((s) => s.name === AUTH_UNIT)!;
    expect(auth.env.DATABASE_URL).toBe('${{ db.url }}');
    expect(auth.env.AUTH_SQLITE_PATH).toBeUndefined();
    expect(auth.env.AUTH_EMAIL).toBe('none');
    expect(auth.env.AUTH_MICROSOFT_TENANT).toBe('acme-tenant');
    expect(auth.volumes).toEqual([]);
    expect(auth.dependsOn).toEqual(['db']);
  });

  it('no auth: block ⇒ no auth service and no SWARMY_AUTH_URL', () => {
    const r = parseAppConfig('version: 1\napp: shop\nservices:\n  web:\n    image: nginx:1.27\n    port: 80\n    domains: [shop.example.com]\n');
    const d = toDesired(r.config!);
    expect(d.services.map((s) => s.name)).toEqual(['web']);
    expect(d.services[0]!.env.SWARMY_AUTH_URL).toBeUndefined();
  });

  it('located errors: oidc without an issuer, no sign-in method, a bad database, the reserved name', () => {
    const codes = (t: string) => parseAppConfig(t).issues.map((i) => i.code);
    expect(codes(YAML('  providers: [oidc]\n'))).toContain('auth/oidc-issuer');
    expect(codes(YAML('  email: none\n'))).toContain('auth/no-method');
    expect(codes(YAML('  providers: [github]\n  database: nope\n'))).toContain('auth/database');
    expect(codes(YAML('  providers: [github]\n', '  swarmy-auth:\n    image: x:1\n'))).toContain('auth/name-taken');
    expect(codes(YAML('  providers: [facebook]\n')).length).toBeGreaterThan(0);
  });
});
