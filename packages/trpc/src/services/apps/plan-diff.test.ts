import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../../context';
import { baseEnvironmentOf, pickBase, readPlanDiff, type BaseCandidate } from './plan-diff';

const d = (iso: string): Date => new Date(iso);
const c = (id: string, sha: string, created: string, applied: boolean, o: Partial<BaseCandidate> = {}): BaseCandidate => ({
  id,
  sha,
  stack: 'shop',
  environment: 'production',
  appliedAt: applied ? d(created) : null,
  createdAt: d(created),
  desiredJson: null,
  ...o,
});

describe('pickBase (board 26 YAML diff)', () => {
  const live = c('p2', 'bbb', '2026-10-25T10:00:00Z', true);
  const older = c('p1', 'aaa', '2026-10-24T10:00:00Z', true);

  it('a pending plan compares with the release that is live', () => {
    const row = { id: 'p3', sha: 'ccc', stack: 'shop', environment: 'production', createdAt: d('2026-10-26T10:00:00Z') };
    expect(pickBase(row, [live, older])).toEqual({ base: live, relation: 'live' });
  });

  it('the live release compares with the one before it', () => {
    expect(pickBase({ ...live, environment: 'production' }, [live, older])).toEqual({ base: older, relation: 'before' });
  });

  it('skips a release at the same commit (a confirm or retry of it) and unapplied plans', () => {
    const row = { id: 'p4', sha: 'bbb', stack: 'shop', environment: 'production', createdAt: d('2026-10-26T10:00:00Z') };
    const failed = c('p3', 'zzz', '2026-10-25T12:00:00Z', false);
    expect(pickBase(row, [failed, live, older])).toEqual({ base: older, relation: 'before' });
  });

  it('a first deploy has nothing to compare with', () => {
    expect(pickBase({ ...older, environment: 'production' }, [older])).toBeNull();
  });

  it('a preview compares with what its environment runs now', () => {
    const row = { id: 'pr', sha: 'eee', stack: 'shop-pr7', environment: 'preview', createdAt: d('2026-10-20T00:00:00Z') };
    expect(pickBase(row, [live, older])).toEqual({ base: live, relation: 'live' });
    expect(baseEnvironmentOf({ environment: 'preview', desiredJson: { previewData: { fromEnvironment: 'staging' } } })).toBe('staging');
    expect(baseEnvironmentOf({ environment: 'preview', desiredJson: {} })).toBe('production');
    expect(baseEnvironmentOf({ environment: 'qa', desiredJson: null })).toBe('qa');
  });
});

describe('readPlanDiff', () => {
  const desired = (replicas: number) => ({
    app: 'shop', stack: 'shop', environment: 'production', services: [{ name: 'web', serviceName: 'shop_web', replicas, sig: `s${replicas}`, source: { kind: 'image', image: 'x:1' } }],
    resources: [], routes: [], jobs: [], connect: [], previews: {},
  });
  const rows = [
    { ...c('p2', 'b'.repeat(40), '2026-10-26T00:00:00Z', false), repoId: 'r1', desiredJson: desired(3) },
    { ...c('p1', 'a'.repeat(40), '2026-10-25T00:00:00Z', true), repoId: 'r1', desiredJson: desired(2) },
  ];
  const ctx = {
    activeOrgId: 'org1',
    db: {
      appPlan: {
        findFirst: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
        findMany: async () => rows.filter((r) => r.appliedAt),
      },
      gitRepo: { findFirst: async () => ({ id: 'r1', branch: 'main', configPath: 'swarmy.yaml' }) },
    },
  } as unknown as OrgContext;

  it('reads both files and renders both specs without signatures', async () => {
    const read = async (_c: OrgContext, _r: unknown, sha: string) => ({ text: `sha: ${sha.slice(0, 1)}\n`, fetchedAt: '' });
    const v = await readPlanDiff(ctx, 'p2', read);
    expect(v.base).toMatchObject({ planId: 'p1', relation: 'live' });
    expect(v.file).toEqual({ before: 'sha: a\n', after: 'sha: b\n' });
    expect(v.spec?.before).toContain('replicas: 2');
    expect(v.spec?.after).toContain('replicas: 3');
    expect(v.spec?.after).not.toContain('sig:');
  });

  it('still shows the spec when git can’t be read', async () => {
    const v = await readPlanDiff(ctx, 'p2', async () => {
      throw new Error('no Builder is online');
    });
    expect(v.file).toBeNull();
    expect(v.fileError).toBe("couldn't read swarmy.yaml from git: no Builder is online");
    expect(v.spec?.after).toContain('replicas: 3');
  });
});
