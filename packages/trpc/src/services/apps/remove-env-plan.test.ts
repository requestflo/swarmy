import { describe, expect, it } from 'bun:test';
import { orphanMarker, planEnvRemoval, type EnvRemovalInput } from './remove-env-plan';

const routes = (...hosts: string[]): string => JSON.stringify(hosts.map((host) => ({ host, port: 3000, tls: 'auto' })));

const LIVE: EnvRemovalInput['live'] = [
  {
    name: 'shop-qa_web',
    labels: { 'swarmy.app.stack': 'shop-qa', 'swarmy.ingress.routes': routes('web-shop-qa.1-2-3-4.sslip.io', 'qa.shop.dev') },
    mounts: [{ type: 'volume', source: 'shop-qa_web-uploads' }, { type: 'bind', source: '/etc/hosts' }],
  },
  { name: 'shop-qa_api', labels: { 'swarmy.app.stack': 'shop-qa' } },
  // Its Postgres (managed data, not an app service) and production's web: neither counts.
  { name: 'shop-qa_db-1', labels: { 'swarmy.db.cluster': 'db' }, mounts: [{ type: 'volume', source: 'shop-qa_db-1-data' }] },
  { name: 'shop_web', labels: { 'swarmy.app.stack': 'shop', 'swarmy.ingress.routes': routes('shop.example.com') } },
];

const input = (data: 'keep' | 'delete'): EnvRemovalInput => ({
  stack: 'shop-qa',
  data,
  desired: {
    services: [
      { name: 'web', volumes: [{ name: 'uploads', volumeName: 'shop-qa_web-uploads', target: '/data' }] },
      // Never ran: its volume still counts.
      { name: 'worker', volumes: [{ name: 'tmp', volumeName: 'shop-qa_worker-tmp', target: '/tmp' }] },
    ] as never,
    resources: [{ name: 'db', type: 'postgres' }] as never,
  },
  ledger: {
    resources: { db: { name: 'db', type: 'postgres' }, cache: { name: 'cache', type: 'cache' } } as never,
    jobs: { nightly: { sig: 'x', jobId: 'job-1' } },
    connect: ['billing'],
    kept: { olddb: ['shop-qa_olddb-1-data'] },
  },
  live: LIVE,
  secretFamilies: ['stripe-key.qa'],
});

describe('planEnvRemoval — what goes and what stays', () => {
  it('keep (the default): the app, its routes, jobs, links, throwaway resources and own secrets go; data stays', () => {
    expect(planEnvRemoval(input('keep'))).toEqual({
      remove: {
        services: ['shop-qa_api', 'shop-qa_web'],
        jobs: ['nightly'],
        links: ['billing'],
        resources: ['cache'],
        databases: [],
        volumes: [],
        secrets: ['stripe-key.qa'],
        hosts: ['qa.shop.dev', 'web-shop-qa.1-2-3-4.sslip.io'],
      },
      keep: { databases: ['db'], volumes: ['shop-qa_olddb-1-data', 'shop-qa_web-uploads', 'shop-qa_worker-tmp'] },
    });
  });

  it('delete: its databases and every named volume go too, nothing is kept', () => {
    const plan = planEnvRemoval(input('delete'));
    expect(plan.remove.databases).toEqual(['db']);
    expect(plan.remove.volumes).toEqual(['shop-qa_olddb-1-data', 'shop-qa_web-uploads', 'shop-qa_worker-tmp']);
    expect(plan.keep).toEqual({ databases: [], volumes: [] });
  });

  it('never touches another stack, a bind mount or a managed-data service', () => {
    const plan = planEnvRemoval(input('delete'));
    expect(plan.remove.services).not.toContain('shop_web');
    expect(plan.remove.hosts).not.toContain('shop.example.com');
    expect(plan.remove.volumes).not.toContain('/etc/hosts');
    expect(plan.remove.volumes).not.toContain('shop-qa_db-1-data'); // the database's own (removeDb deletes it)
  });
});

describe('orphanMarker — the mark a GC finds kept data by', () => {
  it('labels what was kept and names it uniquely; nothing kept, no mark', () => {
    const keep = planEnvRemoval(input('keep')).keep;
    const m = orphanMarker('org1', 'shop-qa', 'qa', keep, 'k3x9');
    expect(m?.name).toBe('swarmy-orphaned.shop-qa.k3x9');
    expect(m?.labels).toEqual({
      'swarmy.orphaned': 'app.environment.remove',
      'swarmy.orphaned.org': 'org1',
      'swarmy.orphaned.stack': 'shop-qa',
      'swarmy.orphaned.environment': 'qa',
    });
    expect(JSON.parse(m!.data)).toEqual({ stack: 'shop-qa', environment: 'qa', volumes: keep.volumes, databases: ['db'] });
    expect(orphanMarker('org1', 'shop-qa', 'qa', { volumes: [], databases: [] }, 'k3x9')).toBeNull();
  });
});
