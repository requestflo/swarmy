import { describe, expect, it } from 'bun:test';
import { cloneDesired, cloneNameProblem, cloneYaml } from './clone-env';
import { parseAppConfig } from './parse';
import { emptyLive, planApp } from './plan';
import type { AppConfig } from './schema';

const YAML = `version: 1
app: shop
env: { NODE_ENV: production }
services:
  web:
    image: ghcr.io/x/web:1
    port: 3000
    domains: [shop.example.com]
    env:
      DATABASE_URL: \${{ db.url }}
      STRIPE_KEY: \${{ secrets.stripe-key }}
  api:
    image: ghcr.io/x/api:1
    secrets: [stripe-key, sendgrid]
resources:
  db: postgres
previews: { enabled: true, data: { from: production, scrub: db/mask.sql } }
environments:
  staging:
    branch: staging
    env: { LOG_LEVEL: debug }
    services:
      web: { replicas: 1, domains: [staging.example.com] }
`;

const cfg = (text = YAML): AppConfig => {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return r.config;
};

describe('cloneNameProblem', () => {
  it('refuses bad, reserved, declared and taken names', () => {
    expect(cloneNameProblem(cfg(), 'QA')).toContain('lowercase');
    expect(cloneNameProblem(cfg(), 'preview')).toContain('reserved');
    expect(cloneNameProblem(cfg(), 'staging')).toContain('already in swarmy.yaml');
    expect(cloneNameProblem(cfg(), 'qa', ['qa'])).toContain('already has');
    expect(cloneNameProblem(cfg(), 'qa')).toBeNull();
  });
});

describe('cloneDesired — a long-lived environment of its own', () => {
  const d = cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'production' });

  it('is its own named stack, never a preview, and records where it came from', () => {
    expect(d.stack).toBe('shop-qa');
    expect(d.environment).toBe('qa');
    expect(d.preview).toBeUndefined();
    expect(d.previewData).toBeUndefined();
    expect(d.dashboard?.branch).toBe('qa');
    expect(d.dashboard?.from).toBe('production');
  });

  it('never takes production’s hostnames', () => {
    expect(d.routes).toEqual([]);
  });

  it('gives each service production serves on a domain its own stable address, and nothing else one', () => {
    const hostFor = (svc: string): string => `${svc}-shop-qa.1-2-3-4.sslip.io`;
    const qa = cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'production' }, { hostFor });
    expect(qa.routes.map(({ sig: _s, ...r }) => r)).toEqual([
      { host: 'web-shop-qa.1-2-3-4.sslip.io', path: '/', service: 'web', port: 3000, stripPath: false },
    ]);
    // A clone of staging drops staging's own domain too, and gets the same address.
    const fromStaging = cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'staging' }, { hostFor });
    expect(fromStaging.routes.map((r) => r.host)).toEqual(['web-shop-qa.1-2-3-4.sslip.io']);
    // Stable: the same input plans the same route (same signature), push after push.
    expect(cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'production' }, { hostFor }).routes).toEqual(qa.routes);
  });

  it('copies no secret: each becomes an empty slot of its own family', () => {
    expect(d.dashboard?.secretSlots).toEqual([
      { family: 'sendgrid', envFamily: 'sendgrid.qa', consumers: [{ service: 'api' }] },
      { family: 'stripe-key', envFamily: 'stripe-key.qa', consumers: [{ service: 'api' }, { service: 'web', envName: 'STRIPE_KEY' }] },
    ]);
    const web = d.services.find((s) => s.name === 'web')!;
    expect(web.env.STRIPE_KEY).toBeUndefined();
    expect(web.env.DATABASE_URL).toBe('${{ db.url }}');
    expect(web.bindings).toEqual(['db.url']);
    expect(d.services.every((s) => s.secrets.length === 0)).toBe(true);
  });

  it('plans without wiring any secret (it deploys before the slots are filled)', () => {
    const plan = planApp(d, emptyLive(d.stack), { changedPaths: [] });
    expect(plan.status).not.toBe('blocked');
    expect(JSON.stringify(plan)).not.toContain('stripe-key');
  });

  it('inherits a named environment’s overrides but not its domains', () => {
    const qa = cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'staging' });
    expect(qa.services.find((s) => s.name === 'web')?.replicas).toBe(1);
    expect(qa.services.find((s) => s.name === 'api')?.env.LOG_LEVEL).toBe('debug');
    expect(qa.routes).toEqual([]);
    expect(() => cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'nope' })).toThrow('no environment named');
  });

  it('starts its database as a copy of the source’s newest backup, masked when asked', () => {
    const copy = cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'production', data: { mask: true } });
    expect(copy.previewData).toEqual({ fromStack: 'shop', fromEnvironment: 'production', scrub: 'db/mask.sql' });
    const raw = cloneDesired(cfg(), { name: 'qa', branch: 'qa', from: 'staging', data: { mask: false } });
    expect(raw.previewData).toEqual({ fromStack: 'shop-staging', fromEnvironment: 'staging' });
    const noScrub = cfg(YAML.replace(', scrub: db/mask.sql', ''));
    expect(() => cloneDesired(noScrub, { name: 'qa', branch: 'qa', from: 'production', data: { mask: true } })).toThrow('no mask step');
  });

  it('prints the swarmy.yaml that makes it part of the file', () => {
    expect(cloneYaml('qa', 'release/qa')).toBe('environments:\n  qa:\n    branch: release/qa\n');
  });
});
