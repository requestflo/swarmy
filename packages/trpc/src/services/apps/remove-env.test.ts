import { describe, expect, it } from 'bun:test';
import type { DashboardEnvMarker } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { REMOVED } from './dashboard-envs';
import { emptyLedger } from './live';
import { removeEnvironment, type RemoveEnvOps } from './remove-env';

const MARKER: DashboardEnvMarker = {
  branch: 'qa',
  from: 'production',
  data: { mask: false },
  secretSlots: [{ family: 'stripe-key', envFamily: 'stripe-key.qa', consumers: [{ service: 'api' }] }],
};
const QA_DESIRED = { stack: 'shop-qa', environment: 'qa', services: [], resources: [{ name: 'db', type: 'postgres' }], dashboard: MARKER };
const ROUTES = JSON.stringify([{ host: 'web-shop-qa.1-2-3-4.sslip.io', port: 3000, tls: 'auto' }]);

type Row = { id: string; repoId: string; environment: string; stack: string; prNumber: number; sha: string; status: string; createdAt: string; desiredJson: unknown };
const row = (id: string, environment: string, stack: string, desiredJson: unknown, createdAt = '2026-10-21'): Row => ({
  id, repoId: 'r1', environment, stack, prNumber: 0, sha: 'a'.repeat(40), status: 'applied', createdAt, desiredJson,
});

/** AppPlan rows + an audit sink + a live stack label set, over the queries removeEnvironment makes. */
function world(rows: Row[], liveLabels: Record<string, string> = {}) {
  const audit: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const byDate = () => [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const match = (r: Row, w: Record<string, unknown>) =>
    (w.stack === undefined || r.stack === w.stack) && (w.environment === undefined || r.environment === w.environment) &&
    (w.prNumber === undefined || r.prNumber === w.prNumber) &&
    !((w.NOT as { environment?: { in: string[] } } | undefined)?.environment?.in.includes(r.environment));
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    hub: {
      liveInventory: () => ({
        services: [{
          id: 's1', name: 'shop-qa_web', image: 'x', mode: 'replicated', replicas: 1, runningReplicas: 1, desiredReplicas: 1,
          labels: { 'com.docker.stack.namespace': 'shop-qa', 'swarmy.app.stack': 'shop-qa', 'swarmy.ingress.routes': ROUTES, ...liveLabels },
          mounts: [{ type: 'volume', source: 'shop-qa_web-uploads', target: '/data' }],
          networks: [], env: [], ports: [], createdAt: 0, updatedAt: 0,
        }],
        containers: [],
      }),
    },
    db: {
      appPlan: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => byDate().find((r) => match(r, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => byDate().filter((r) => match(r, where)),
        update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
      },
      gitRepo: { findFirst: async () => ({ id: 'r1', branch: 'main' }) },
      auditLog: { create: async ({ data }: { data: (typeof audit)[number] }) => audit.push(data) },
    },
  } as unknown as OrgContext;
  return { ctx, rows, audit };
}

function fakeOps(calls: string[], opts: { deleteFails?: boolean } = {}): RemoveEnvOps {
  return {
    lock: (_r, env, fn) => (calls.push(`lock ${env}`), fn()),
    ledger: async () => ({ ...emptyLedger(), resources: { db: { name: 'db', type: 'postgres' } as never } }),
    allowDelete: async (stack, dbs) => void calls.push(`allow ${stack} ${dbs.join(',')}`),
    teardown: async ({ desired }) => (calls.push(`teardown ${desired.stack}`), ['shop-qa_web', 'shop-qa_api']),
    deleteDatabase: async (stack, db, gone) => (calls.push(`delete ${stack}/${db} after ${gone.join(',')}`), !opts.deleteFails),
    removeVolumes: async (stack, vols) => (calls.push(`volumes ${stack} ${vols.join(',')}`), { deleted: [...vols], failed: [] }),
    markOrphaned: async (m) => void calls.push(`orphaned ${m.labels['swarmy.orphaned.stack']} ${m.data}`),
    removeSecrets: async (_s, families) => (calls.push(`secrets ${families.join(',')}`), { removed: [...families], kept: [] }),
    forgetStack: async (stack) => void calls.push(`forget ${stack}`),
  };
}

const prod = row('p1', 'production', 'shop', { stack: 'shop', environment: 'production', resources: [] }, '2026-10-20');

describe('removeEnvironment — a cloned environment, never one the file or production owns', () => {
  it('keeps its data by default: tears down the rest, removes its own secrets, marks what it kept orphaned, drops the marker, audits', async () => {
    const w = world([prod, row('q1', 'qa', 'shop-qa', QA_DESIRED, '2026-10-21'), row('q2', 'qa', 'shop-qa', QA_DESIRED, '2026-10-22')]);
    const calls: string[] = [];
    const res = await removeEnvironment(w.ctx, { stack: 'shop-qa', confirm: 'shop-qa', data: 'keep' }, fakeOps(calls));
    expect(calls).toEqual([
      'lock qa', 'teardown shop-qa', 'secrets stripe-key.qa',
      'orphaned shop-qa {"stack":"shop-qa","environment":"qa","volumes":["shop-qa_web-uploads"],"databases":["db"]}',
    ]);
    expect(res).toEqual({
      environment: 'qa', stack: 'shop-qa', services: ['shop-qa_web', 'shop-qa_api'], hosts: ['web-shop-qa.1-2-3-4.sslip.io'],
      databases: { kept: ['db'], deleted: [] }, volumes: { kept: ['shop-qa_web-uploads'], deleted: [] },
      secrets: { removed: ['stripe-key.qa'], kept: [] },
    });
    // Every row loses the marker and reads removed — nothing re-plans it, the name is free.
    for (const r of w.rows.filter((x) => x.environment === 'qa')) {
      expect(r.status).toBe(REMOVED);
      expect((r.desiredJson as { dashboard?: unknown }).dashboard).toBeUndefined();
    }
    expect(w.rows.find((r) => r.id === 'p1')?.status).toBe('applied');
    const audit = w.audit.find((a) => a.action === 'app.environment.remove')?.metadata;
    expect(audit).toMatchObject({ environment: 'qa', data: 'keep', volumes: { kept: ['shop-qa_web-uploads'] } });
    expect(String(audit?.orphanMarker)).toStartWith('swarmy-orphaned.shop-qa.');
  });

  it('delete: data.destroy first, the database goes after its app, then its volumes; nothing marked, the stack forgotten', async () => {
    const w = world([prod, row('q1', 'qa', 'shop-qa', QA_DESIRED)]);
    const calls: string[] = [];
    const res = await removeEnvironment(w.ctx, { stack: 'shop-qa', confirm: 'shop-qa', data: 'delete' }, fakeOps(calls));
    expect(calls).toEqual([
      'allow shop-qa db', 'lock qa', 'teardown shop-qa', 'delete shop-qa/db after shop-qa_web,shop-qa_api',
      'volumes shop-qa shop-qa_web-uploads', 'secrets stripe-key.qa', 'forget shop-qa',
    ]);
    expect(res.databases).toEqual({ kept: [], deleted: ['db'] });
    expect(res.volumes).toEqual({ kept: [], deleted: ['shop-qa_web-uploads'] });
  });

  it('a database that would not go is reported kept and marked orphaned, and the stack stays', async () => {
    const w = world([prod, row('q1', 'qa', 'shop-qa', QA_DESIRED)]);
    const calls: string[] = [];
    const res = await removeEnvironment(w.ctx, { stack: 'shop-qa', confirm: 'shop-qa', data: 'delete' }, fakeOps(calls, { deleteFails: true }));
    expect(res.databases).toEqual({ kept: ['db'], deleted: [] });
    expect(calls).not.toContain('forget shop-qa');
    expect(calls.at(-1)).toBe('orphaned shop-qa {"stack":"shop-qa","environment":"qa","volumes":[],"databases":["db"]}');
  });

  it('refuses without the typed name, for production, a production-marked stack, swarmy.yaml environments and a gone one', async () => {
    const staging = row('s1', 'staging', 'shop-staging', { stack: 'shop-staging', environment: 'staging', resources: [] });
    const go = (stack: string, rows: Row[], labels: Record<string, string> = {}, confirm = stack) => {
      const calls: string[] = [];
      return removeEnvironment(world(rows, labels).ctx, { stack, confirm, data: 'keep' }, fakeOps(calls)).then(() => calls);
    };
    await expect(go('shop-qa', [prod, row('q1', 'qa', 'shop-qa', QA_DESIRED)], {}, 'qa')).rejects.toThrow('type shop-qa');
    await expect(go('shop', [prod])).rejects.toThrow('is production');
    await expect(go('shop-qa', [prod, row('q1', 'qa', 'shop-qa', QA_DESIRED)], { 'swarmy.env': 'production' })).rejects.toThrow('is production');
    await expect(go('shop-staging', [prod, staging])).rejects.toThrow('swarmy.yaml declares staging');
    // Adopted: the newest row has no marker — the file owns it now.
    await expect(go('shop-qa', [prod, row('q1', 'qa', 'shop-qa', QA_DESIRED), row('q2', 'qa', 'shop-qa', { stack: 'shop-qa' }, '2026-10-23')])).rejects.toThrow('swarmy.yaml declares qa');
    await expect(go('shop-qa', [prod, { ...row('q1', 'qa', 'shop-qa', {}), status: REMOVED }])).rejects.toThrow('not found');
    await expect(go('billing', [prod])).rejects.toThrow('not found');
  });
});
