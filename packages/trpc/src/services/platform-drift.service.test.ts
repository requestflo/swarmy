import { describe, expect, it } from 'bun:test';
import { buildPlatformManifest } from '@swarmy/core/platform-manifest';
import { getPlatformDrift, repinSystemService } from './platform-drift.service';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const release = buildPlatformManifest({ version: '1.3.0', channel: 'stable', commit: 'n', digests: { controller: D('b'), dns: D('d') } });

function world(opts: { active?: boolean; rc?: string } = {}) {
  const dispatched: string[] = [];
  const audit: Array<{ action: string; metadata: any }> = [];
  const services = [
    { name: 'swarmy_controller', image: `ghcr.io/requestflo/swarmy-controller@${D('a')}` },
    { name: 'swarmy-dns', image: 'ghcr.io/requestflo/swarmy-dns:latest' },
  ];
  const ctx: any = {
    activeOrgId: 'org_1',
    user: { id: 'u1' },
    db: {
      platformConfig: { upsert: async () => ({ orgId: 'org_1', currentManifest: release }) },
      platformUpgradeRun: { findFirst: async () => (opts.active ? { id: 'r1' } : null) },
      auditLog: { create: async ({ data }: any) => void audit.push(data) },
    },
    hub: {
      managerNode: () => 'n1',
      liveInventory: () => ({ services, containers: [] }),
      dispatch: async (_n: string, _cmd: string, p: any) => {
        dispatched.push(p.cmd[0]);
        return { exitCode: 0, output: `@@SWARMY-UPDATE@@ ${opts.rc ?? '0 completed'}` };
      },
    },
  };
  return { ctx, dispatched, audit };
}

describe('platform drift — read + re-pin', () => {
  it('reads the rows off the live inventory against the current release', async () => {
    const v = await getPlatformDrift(world().ctx);
    expect(v).toMatchObject({ version: '1.3.0', builtIn: false, runActive: false });
    expect(v.rows.map((r) => `${r.service}:${r.action}`)).toEqual(['swarmy_controller:explain', 'swarmy-dns:repin']);
  });

  it('re-pins with the health-gated update and audits what happened', async () => {
    const w = world();
    const r = await repinSystemService(w.ctx, { service: 'swarmy-dns' });
    expect(r).toEqual({ service: 'swarmy-dns', to: `ghcr.io/requestflo/swarmy-dns@${D('d')}`, landed: true, state: 'completed' });
    expect(w.dispatched[0]).toContain(`--image 'ghcr.io/requestflo/swarmy-dns@${D('d')}'`);
    expect(w.dispatched[0]).toContain('--update-failure-action rollback');
    expect(w.audit[0]).toMatchObject({ action: 'platform.drift.repin', metadata: { from: 'ghcr.io/requestflo/swarmy-dns:latest', landed: true } });
  });

  it('says so when Swarm rolled it back; refuses the controller, a service already on the release, and a live run', async () => {
    expect((await repinSystemService(world({ rc: '0 rollback_completed' }).ctx, { service: 'swarmy-dns' })).landed).toBe(false);
    await expect(repinSystemService(world().ctx, { service: 'swarmy_controller' })).rejects.toThrow(/moves with an upgrade/);
    await expect(repinSystemService(world().ctx, { service: 'swarmy-clickhouse' })).rejects.toThrow(/already runs what 1.3.0 names/);
    const busy = world({ active: true });
    await expect(repinSystemService(busy.ctx, { service: 'swarmy-dns' })).rejects.toThrow(/running or paused/);
    expect(busy.dispatched).toEqual([]);
  });
});
