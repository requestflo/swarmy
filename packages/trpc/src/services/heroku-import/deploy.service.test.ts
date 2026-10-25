import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../../context';
import { cachePrimaryName } from '../cache.service';
import { deployHerokuImport, type DeployDeps } from './deploy.service';
import { importView } from './plan.service';
import { resolveHeroku } from './source';

const PASTE = {
  kind: 'paste' as const,
  appJson: JSON.stringify({ name: 'acme-shop', env: { SESSION_SECRET: { generator: 'secret' } }, addons: ['heroku-postgresql:standard-0', 'heroku-redis:mini'], formation: { web: { quantity: 2, size: 'standard-2x' } } }),
  procfile: 'web: npm start\nworker: node worker.js\nrelease: npm run migrate',
  config: [
    "DATABASE_URL='postgres://u1:pgsecret@ec2-1.compute-1.amazonaws.com:5432/d1'",
    "REDIS_URL='redis://:redissecret@ec2-2.compute-1.amazonaws.com:6379'",
    "STRIPE_SECRET_KEY='sk_live_abcdefghijklmnop'",
    "NODE_ENV='production'",
  ].join('\n'),
  domains: 'shop.acme.example',
};

function ctx(audit: Array<{ action: string; metadata?: unknown }>): OrgContext {
  return {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    db: { auditLog: { create: async ({ data }: { data: { action: string; metadata?: unknown } }) => void audit.push(data) } },
  } as unknown as OrgContext;
}

describe('Import from Heroku: plan view and Deploy', () => {
  it('the plan carries names, never values, and says what the controller can seal and copy', async () => {
    const view = importView(await resolveHeroku(PASTE), 'paste');
    const json = JSON.stringify(view);
    for (const v of ['pgsecret', 'redissecret', 'sk_live']) expect(json).not.toContain(v);
    expect(view).toMatchObject({ app: 'acme-shop', valid: true, sealable: ['stripe-secret-key'], copyable: ['db'] });
    expect(view.plan.headline).toBe('acme-shop comes across as 2 services, a Postgres database and a cache.');
    expect(view.plan.domains).toEqual(['shop.acme.example']);
  });

  it('starts the data stores and seals the secrets it has values for; keeps what exists; audits', async () => {
    const audit: Array<{ action: string; metadata?: unknown }> = [];
    const made: string[] = [];
    const deps: DeployDeps = {
      resolve: (src, name) => resolveHeroku(src, name),
      liveServiceNames: () => new Set([cachePrimaryName('acme-shop', 'cache')]),
      createResource: async (_c, r) => void made.push(`resource:${r.name}`),
      createSecret: async (_c, family, value) => {
        if (family === 'stripe-secret-key' && value !== 'sk_live_abcdefghijklmnop') throw new Error('wrong value');
        made.push(`secret:${family}`);
      },
    };
    const r = await deployHerokuImport(ctx(audit), { source: PASTE, stack: 'acme-shop' }, deps);
    expect(made).toEqual(['resource:db', 'secret:stripe-secret-key']);
    expect(r.steps.map((s) => [s.key, s.status])).toEqual([
      ['resources.cache', 'already'],
      ['resources.db', 'created'],
      ['secrets.session-secret', 'skipped'],
      ['secrets.stripe-secret-key', 'created'],
    ]);
    expect(r.yaml).toContain('app: acme-shop');
    expect(audit.map((a) => a.action)).toEqual(['heroku.import.deploy']);
    expect(JSON.stringify(audit)).not.toContain('sk_live');
  });

  it('a step that fails is said, and the rest still run; an existing secret is kept', async () => {
    const deps: DeployDeps = {
      resolve: (src, name) => resolveHeroku(src, name),
      liveServiceNames: () => new Set(),
      createResource: async (_c, r) => {
        if (r.name === 'db') throw new Error('no manager node is online');
      },
      createSecret: async () => {
        throw new Error('secret family "stripe-secret-key" already exists — rotate it instead');
      },
    };
    const r = await deployHerokuImport(ctx([]), { source: PASTE, stack: 'acme-shop' }, deps);
    expect(r.steps.find((s) => s.key === 'resources.db')).toMatchObject({ status: 'failed', say: 'Couldn’t start the Postgres 16 database “db”: no manager node is online' });
    expect(r.steps.find((s) => s.key === 'resources.cache')!.status).toBe('created');
    expect(r.steps.find((s) => s.key === 'secrets.stripe-secret-key')!.status).toBe('already');
  });
});
