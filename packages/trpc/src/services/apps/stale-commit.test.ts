import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../../context';
import type { AgentHub } from '../../hub/types';
import { planCommit } from '../apps.service';
import { staleCommitReason } from './stale-commit';

const [X, Y, Z] = ['1', '2', '3'].map((c) => c.repeat(40)) as [string, string, string];

describe('M8: a replayed push never rolls an app back (pure rule)', () => {
  const applied = [{ sha: Z }, { sha: Y }, { sha: X }]; // newest first: Z is live
  it('refuses a commit that already ran here and was replaced since', () => {
    expect(staleCommitReason({ sha: Y, before: X, applied })).toContain('older than 3333333, which is live');
    expect(staleCommitReason({ sha: X, before: null, applied })).not.toBeNull();
  });
  it('lets through new commits, the live one, and an explicit revert in git', () => {
    expect(staleCommitReason({ sha: 'f'.repeat(40), before: Z, applied })).toBeNull(); // never ran here
    expect(staleCommitReason({ sha: Z, before: Y, applied })).toBeNull(); // redelivery of what runs: a no-op plan
    expect(staleCommitReason({ sha: Y, before: Z, applied })).toBeNull(); // the branch was force-moved back from live
    expect(staleCommitReason({ sha: Y, before: X, applied: [] })).toBeNull(); // nothing applied yet
  });
});

describe('M8: planCommit refuses a stale push before planning anything', () => {
  let t: TestDb;
  const dispatched: string[] = [];
  beforeAll(async () => {
    t = await createTestDb();
    await t.db.organization.create({ data: { id: 'org1', name: 'Org', slug: 'org' } });
    await t.db.node.create({ data: { id: 'n1', orgId: 'org1', name: 'b', hostname: 'b' } });
    await t.db.gitRepo.create({ data: { id: 'r1', orgId: 'org1', provider: 'GENERIC', url: 'https://git.example/shop.git' } });
    const plan = (sha: string, updatedAt: Date) => ({
      orgId: 'org1', repoId: 'r1', environment: 'production', stack: 'shop', sha, trigger: 'push', status: 'applied', updatedAt,
    });
    await t.db.appPlan.create({ data: plan(Y, new Date(Date.now() - 60_000)) });
    await t.db.appPlan.create({ data: plan(Z, new Date()) });
  });
  afterAll(() => t.close());

  const yaml = Buffer.from('version: 1\napp: shop\nservices: { web: { image: "a:1" } }\n').toString('base64');
  const ctx = () =>
    ({
      db: t.db,
      activeOrgId: 'org1',
      user: null,
      hub: {
        isOnline: () => true,
        nodeInfoFor: () => ({ labels: { 'swarmy.node.builder': 'true' } }),
        agentBuildFor: () => undefined,
        // planCommit reads production's saved preview rules off the live services.
        liveInventory: () => ({ services: [], containers: [] }),
        dispatch: async (_n: string, cmd: string) => {
          dispatched.push(cmd);
          return { exitCode: 0, timedOut: false, output: `SWARMY_BEGIN\nSWARMY_HEAD ${Y}\nSWARMY_FILE\tswarmy.yaml\t${yaml}\nSWARMY_END\n` };
        },
      } as unknown as AgentHub,
    }) as unknown as OrgContext;

  it('a replayed push of Y (Z is live) is refused, audited, and plans nothing', async () => {
    const res = await planCommit(ctx(), { repoId: 'r1', ref: 'main', sha: Y, trigger: 'push', before: X });
    expect(res).toMatchObject({ planId: null, status: 'stale', environment: 'production' });
    expect(dispatched).toEqual(['container.runOnce']); // read the commit; nothing applied
    const audit = await t.db.auditLog.findFirst({ where: { action: 'app.plan.stale' } });
    expect(JSON.parse(JSON.stringify(audit?.metadata))).toMatchObject({ sha: Y, live: Z, before: X });
    const rows = await t.db.appPlan.findMany({ where: { repoId: 'r1' }, orderBy: { updatedAt: 'desc' } });
    expect(rows.map((r) => [r.sha, r.status])).toEqual([[Z, 'applied'], [Y, 'applied']]);
  });
});
