import { describe, expect, it } from 'bun:test';
import { toDesired, type DesiredApp } from './desired';
import { FULL_EXAMPLE, MINIMAL_EXAMPLE } from './examples';
import { parseAppConfig } from './parse';
import {
  emptyLive,
  gateResourceUpdate,
  planApp,
  planToMarkdown,
  touches,
  type LiveApp,
} from './plan';

const desired = (text: string, opts?: Parameters<typeof toDesired>[1]): DesiredApp => {
  const r = parseAppConfig(text);
  if (!r.config) throw new Error(JSON.stringify(r.issues));
  return toDesired(r.config, opts);
};

/** The live snapshot a controller would read after fully applying `d`. */
const applied = (d: DesiredApp): LiveApp => ({
  stack: d.stack,
  services: d.services.map((s) => ({
    name: s.name,
    image:
      s.source.kind === 'image'
        ? s.source.image
        : `localhost:5000/${d.app}@sha256:${'a'.repeat(64)}`,
    sig: s.sig,
    ...(s.source.kind === 'build' ? { buildKey: s.source.key } : {}),
    volumes: s.volumes.map((v) => v.name),
    applied: s,
  })),
  resources: d.resources.map((r) => ({ name: r.name, type: r.type, sig: r.sig, applied: r })),
  routes: d.routes.map((r) => ({ host: r.host, path: r.path, service: r.service, sig: r.sig })),
  jobs: d.jobs.map((j) => ({ name: j.name, sig: j.sig })),
  connect: [...d.connect],
});

const ids = (p: ReturnType<typeof planApp>) =>
  p.actions.map((a) => `${a.phase} ${a.gate} ${a.id.replace(/build:[0-9a-f]+/, 'build:<key>')}`);

describe('planApp', () => {
  it('first deploy of the full example: resources → one shared build → deploys → routes/jobs/links', () => {
    const d = desired(FULL_EXAMPLE);
    const plan = planApp(d, emptyLive(d.stack));
    expect(plan.status).toBe('ready');
    expect(ids(plan)).toEqual([
      '1 auto resource.create:db',
      '1 auto resource.create:cache',
      '1 auto resource.create:invoices',
      '1 auto resource.create:search',
      '1 auto resource.create:embeddings',
      '2 auto build:<key>',
      '3 auto service.deploy:admin',
      '3 auto service.deploy:web',
      '3 auto service.deploy:worker',
      '4 auto route.add:admin.northwind.dev',
      '4 auto route.add:api.northwind.dev/v1',
      '4 auto route.add:orders.northwind.dev',
      '4 auto job.create:invoices',
      '4 auto link.add:billing',
    ]);
    const build = plan.actions.find((a) => a.kind === 'build');
    expect(build?.kind === 'build' && build.services).toEqual(['web', 'worker']);
    const admin = plan.actions.find((a) => a.id === 'service.deploy:admin');
    expect(admin?.kind === 'service.deploy' && admin.image).toEqual({
      image: 'ghcr.io/northwind/admin:1.4.2',
    });
  });

  it('require-approval holds every change, not just destructive ones', () => {
    const d = desired(MINIMAL_EXAMPLE);
    const plan = planApp(d, emptyLive(d.stack), { requireApproval: true });
    expect(plan.status).toBe('needs-confirmation');
    expect(plan.counts).toEqual({ auto: 0, confirm: 4, blocked: 0 });
  });

  it('is a noop when live matches and nothing under watch paths changed', () => {
    const d = desired(FULL_EXAMPLE);
    const plan = planApp(d, applied(d), { changedPaths: ['README.md', 'docs/x.md'] });
    expect(plan.status).toBe('noop');
    expect(plan.actions).toEqual([]);
    expect(planToMarkdown(plan)).toBe('### swarmy plan for `orders`\n\nNothing to change.');
  });

  it('monorepo: only a change under the watch paths rebuilds, and rolls every service on that build', () => {
    const d = desired(FULL_EXAMPLE);
    const plan = planApp(d, applied(d), { changedPaths: ['packages/shared/src/money.ts'] });
    expect(ids(plan)).toEqual([
      '2 auto build:<key>',
      '3 auto service.deploy:web',
      '3 auto service.deploy:worker',
    ]);
    expect(plan.actions[0]?.reason).toBe(
      'build services/orders (files changed under packages/shared, services/orders)',
    );
    expect(plan.actions[1]?.reason).toBe('roll web to the new build');
  });

  it('unknown changed paths (e.g. a forced redeploy) rebuild', () => {
    const d = desired(MINIMAL_EXAMPLE);
    expect(ids(planApp(d, applied(d)))).toEqual([
      '2 auto build:<key>',
      '3 auto service.deploy:web',
    ]);
  });

  it('a config-only change redeploys with the running digest, no build', () => {
    const before = desired(MINIMAL_EXAMPLE);
    const after = desired(MINIMAL_EXAMPLE.replace('port: 3000', 'port: 3000\n    replicas: 3'));
    const plan = planApp(after, applied(before), { changedPaths: ['swarmy.yaml'] });
    expect(ids(plan)).toEqual(['3 auto service.deploy:web']);
    const a = plan.actions[0];
    expect(a?.kind === 'service.deploy' && a.image).toEqual({
      image: `localhost:5000/blog@sha256:${'a'.repeat(64)}`,
    });
    expect(a?.kind === 'service.deploy' && a.changes).toEqual([
      { path: 'replicas', from: 1, to: 3 },
    ]);
    expect(a?.reason).toBe('update web (replicas)');
  });

  it('removing a resource never auto-applies; the rest of the plan still does', () => {
    const before = desired(FULL_EXAMPLE);
    const after = desired(
      FULL_EXAMPLE.replace('  search: { type: search, engine: meilisearch }\n', '').replace(
        '      SEARCH_URL: ${{ search.url }}\n',
        '',
      ),
    );
    const plan = planApp(after, applied(before), { changedPaths: ['swarmy.yaml'] });
    expect(plan.status).toBe('needs-confirmation');
    expect(ids(plan)).toEqual(['3 auto service.deploy:web', '6 confirm resource.delete:search']);
    expect(plan.actions[1]?.reason).toBe('delete search "search" and all of its data');
    const pgGone = planApp(desired(MINIMAL_EXAMPLE.replace('resources:\n  db: postgres\n', '').replace('    env:\n      DATABASE_URL: ${{ db.url }}\n', '')), applied(desired(MINIMAL_EXAMPLE)), { changedPaths: [] });
    expect(pgGone.actions.find((a) => a.kind === 'resource.delete')?.reason).toBe(
      'remove postgres "db" — its data volume is kept until you delete it permanently',
    );
  });

  it('removing a service with a volume, or dropping its volume, needs confirmation', () => {
    const before = desired(FULL_EXAMPLE);
    const noVolume = desired(
      FULL_EXAMPLE.replace('    volumes:\n      uploads: /data/uploads\n', ''),
    );
    expect(ids(planApp(noVolume, applied(before), { changedPaths: [] }))).toEqual([
      '3 confirm service.deploy:admin',
    ]);

    const live = applied(before);
    live.services.push({ name: 'legacy', image: 'x@sha256:1', volumes: ['data'] });
    live.services.push({ name: 'stateless', image: 'y@sha256:2', volumes: [] });
    expect(ids(planApp(before, live, { changedPaths: [] }))).toEqual([
      '5 confirm service.remove:legacy',
      '5 auto service.remove:stateless',
    ]);
  });

  it('removals run routes → jobs → links → services, after every upsert', () => {
    const d = desired(MINIMAL_EXAMPLE);
    const live = applied(d);
    live.routes.push({ host: 'old.example.com', path: '/', service: 'web' });
    live.jobs.push({ name: 'gone' });
    live.connect.push('billing');
    expect(ids(planApp(d, live, { changedPaths: [] }))).toEqual([
      '5 auto route.remove:old.example.com',
      '5 auto job.remove:gone',
      '5 auto link.remove:billing',
    ]);
  });

  it('a postgres downgrade blocks the whole plan', () => {
    const before = desired(FULL_EXAMPLE);
    const after = desired(
      FULL_EXAMPLE.replace('version: 16', 'version: 15').replace('replicas: 2', 'replicas: 3'),
    );
    const plan = planApp(after, applied(before), { changedPaths: [] });
    expect(plan.status).toBe('blocked');
    expect(plan.counts).toEqual({ auto: 1, confirm: 0, blocked: 1 });
    expect(planToMarkdown(plan)).toBe(
      [
        '### swarmy plan for `orders`',
        '',
        'Blocked — 1 change cannot be applied.',
        '',
        '```diff',
        'x postgres "db" cannot go from 16 down to 15',
        '+ update web (replicas)',
        '```',
      ].join('\n'),
    );
  });

  it('changing a resource type replaces it — both halves confirmed', () => {
    const before = desired(MINIMAL_EXAMPLE + '  things: cache\n');
    const after = desired(MINIMAL_EXAMPLE + '  things: search\n');
    expect(ids(planApp(after, applied(before), { changedPaths: [] }))).toEqual([
      '1 confirm resource.create:things',
      '6 confirm resource.delete:things',
    ]);
  });

  it('a resource that exists without a swarmy.yaml sig (adoption) needs review', () => {
    const d = desired(MINIMAL_EXAMPLE);
    const live = applied(d);
    live.resources = [{ name: 'db', type: 'postgres' }];
    const plan = planApp(d, live, { changedPaths: [] });
    expect(ids(plan)).toEqual(['1 confirm resource.update:db']);
  });

  it('renders a PR comment with the preview URL', () => {
    const d = desired(MINIMAL_EXAMPLE, { preview: { pr: 7, baseDomain: 'preview.example.com' } });
    const md = planToMarkdown(planApp(d, emptyLive(d.stack)), {
      previewUrl: 'https://pr-7.preview.example.com',
    });
    expect(md).toBe(
      [
        '### swarmy plan for `blog-pr7`',
        '',
        '4 changes will apply.',
        '',
        'Preview: https://pr-7.preview.example.com',
        '',
        '```diff',
        '+ create postgres 16 "db" (single)',
        '+ build the repo root (web is new; new commit)',
        '+ deploy new service web',
        '+ route pr-7.preview.example.com → web:3000',
        '```',
      ].join('\n'),
    );
  });
});

describe('gateResourceUpdate', () => {
  const pg = (
    o: Partial<{
      version: number;
      ha: 'single' | 'primary-replica' | 'failover';
      replicas: number;
      backups: { schedule: string; keep: number } | null;
      database: string;
    }>,
  ) =>
    ({
      name: 'db',
      sig: '',
      type: 'postgres',
      version: 16,
      ha: 'primary-replica',
      replicas: 1,
      database: 'db',
      backups: { schedule: 'daily', keep: 7 },
      ...o,
    }) as const;

  it('auto: more replicas, HA up, backup schedule change', () => {
    expect(gateResourceUpdate(pg({}), pg({ replicas: 2 })).gate).toBe('auto');
    expect(gateResourceUpdate(pg({}), pg({ ha: 'failover' })).gate).toBe('auto');
    expect(gateResourceUpdate(pg({}), pg({ backups: { schedule: 'hourly', keep: 7 } })).gate).toBe(
      'auto',
    );
  });

  it('confirm: major upgrade, HA down, backups off, database switch', () => {
    expect(gateResourceUpdate(pg({}), pg({ version: 17 }))).toEqual({
      gate: 'confirm',
      reason: 'db: upgrade postgres 16 → 17 (dump + restore, brief write downtime)',
    });
    expect(gateResourceUpdate(pg({ ha: 'failover' }), pg({})).gate).toBe('confirm');
    expect(gateResourceUpdate(pg({}), pg({ backups: null })).gate).toBe('confirm');
    expect(gateResourceUpdate(pg({}), pg({ database: 'app' })).gate).toBe('confirm');
  });

  it('bucket going public and cache shrinking need a human', () => {
    const b = (access: 'internal' | 'public') =>
      ({ name: 'b', sig: '', type: 'bucket', access }) as const;
    expect(gateResourceUpdate(b('internal'), b('public')).gate).toBe('confirm');
    expect(gateResourceUpdate(b('public'), b('internal')).gate).toBe('auto');
    const c = (memoryMb: number) =>
      ({
        name: 'c',
        sig: '',
        type: 'cache',
        engine: 'valkey',
        ha: 'single',
        replicas: 0,
        memoryMb,
      }) as const;
    expect(gateResourceUpdate(c(512), c(256)).gate).toBe('confirm');
    expect(gateResourceUpdate(c(256), c(512)).gate).toBe('auto');
  });
});

describe('touches', () => {
  it('matches exact paths and descendants, never siblings with a shared prefix', () => {
    expect(touches(['services/orders/a.ts'], ['services/orders'])).toBe(true);
    expect(touches(['services/orders'], ['services/orders'])).toBe(true);
    expect(touches(['services/orders-v2/a.ts'], ['services/orders'])).toBe(false);
    expect(touches(['anything'], ['.'])).toBe(true);
    expect(touches([], ['.'])).toBe(false);
  });
});
