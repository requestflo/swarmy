import { describe, expect, it } from 'bun:test';
import { toDesired } from './desired';
import { environmentBranches, environmentForBranch, resolveEnvironment } from './environments';
import { FULL_EXAMPLE, MINIMAL_EXAMPLE } from './examples';
import { parseAppConfig } from './parse';
import type { AppConfig } from './schema';

const cfg = (text: string): AppConfig => {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return r.config;
};
const errors = (text: string) =>
  parseAppConfig(text)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => `${i.code} @ ${i.path.join('.')}`);

describe('environments', () => {
  it('routes branches to environments', () => {
    const c = cfg(FULL_EXAMPLE);
    expect(environmentForBranch(c, 'main', 'main')).toBe('production');
    expect(environmentForBranch(c, 'staging', 'main')).toBe('staging');
    expect(environmentForBranch(c, 'feature/x', 'main')).toBeNull();
    expect(environmentBranches(c, 'main')).toEqual([
      { environment: 'production', branch: 'main' },
      { environment: 'staging', branch: 'staging' },
    ]);
  });

  it('staging is its own stack with overrides, no prod domains, no cron, no links', () => {
    const d = toDesired(cfg(FULL_EXAMPLE), { environment: 'staging' });
    expect(d.stack).toBe('orders-staging');
    expect(d.environment).toBe('staging');
    const web = d.services.find((s) => s.name === 'web');
    expect(web?.serviceName).toBe('orders-staging_web');
    expect({ replicas: web?.replicas, cpu: web?.cpu, memoryMb: web?.memoryMb }).toEqual({
      replicas: 1,
      cpu: 0.25,
      memoryMb: 256,
    });
    expect(web?.env.LOG_LEVEL).toBe('debug');
    expect(web?.env.NODE_ENV).toBe('production'); // shared env still flows
    expect(d.services.find((s) => s.name === 'admin')?.sleepAfterSeconds).toBe(300);
    expect(d.routes.map((r) => `${r.host}→${r.service}`)).toEqual([
      'staging.orders.northwind.dev→web',
    ]);
    const db = d.resources.find((r) => r.name === 'db');
    expect(
      db?.type === 'postgres' && {
        ha: db.ha,
        replicas: db.replicas,
        backups: db.backups,
        version: db.version,
      },
    ).toEqual({
      ha: 'single',
      replicas: 0,
      backups: null,
      version: 16,
    });
    const cache = d.resources.find((r) => r.name === 'cache');
    expect(cache?.type === 'cache' && cache.memoryMb).toBe(128);
    expect(d.jobs).toEqual([]);
    expect(d.connect).toEqual([]);
    // Production is untouched by the environment block.
    const prod = toDesired(cfg(FULL_EXAMPLE));
    expect(prod.stack).toBe('orders');
    expect(prod.routes).toHaveLength(3);
    expect(prod.jobs).toHaveLength(1);
  });

  it('a PR against staging previews the staging definition with pr hosts', () => {
    const d = toDesired(cfg(FULL_EXAMPLE), {
      environment: 'staging',
      preview: { pr: 9, baseDomain: 'p.example.com' },
    });
    expect(d.stack).toBe('orders-pr9');
    expect(d.environment).toBe('preview');
    expect(d.services.find((s) => s.name === 'web')?.env.LOG_LEVEL).toBe('debug'); // staging's env
    expect(d.routes.map((r) => r.host)).toEqual(['pr-9-admin.p.example.com', 'pr-9.p.example.com']);
    expect(d.jobs).toEqual([]);
  });

  it('resolveEnvironment is the identity for production', () => {
    const c = cfg(FULL_EXAMPLE);
    expect(resolveEnvironment(c, 'production')).toBe(c);
    expect(() => resolveEnvironment(c, 'qa')).toThrow('no environment named "qa"');
  });

  it('validates environments: names, refs, branches, domains, merged types', () => {
    const text =
      MINIMAL_EXAMPLE +
      [
        'environments:',
        '  production: { branch: prod }',
        '  staging:',
        '    branch: staging',
        '    services: { api: { replicas: 1 } }',
        '    resources: { dbx: { ha: single } }',
        '  qa:',
        '    branch: staging',
        '    services: { web: { domains: [blog.example.com] } }',
        '  dev:',
        '    branch: dev',
        '    resources: { db: { ha: sentinel } }',
        '',
      ].join('\n');
    expect(errors(text)).toEqual([
      'env/reserved @ environments.production',
      'env/unknown-service @ environments.staging.services.api',
      'env/unknown-resource @ environments.staging.resources.dbx',
      'env/branch-taken @ environments.qa.branch',
      'env/domain-taken @ environments.qa.services.web.domains.0',
      'env/invalid @ environments.dev.resources.db.ha',
    ]);
  });

  it('the full example (with staging) parses clean', () => {
    expect(parseAppConfig(FULL_EXAMPLE).issues).toEqual([]);
  });
});
