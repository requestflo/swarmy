import { describe, expect, it } from 'bun:test';
import type { Auth } from '@swarmy/auth';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';
import { REGISTRY_AUTH_LABEL } from './registry-auth';
import { runRegistryGcForOrg } from './registry-gc.service';
import { getRegistryUsage } from './registry-usage';
import { seedKv } from './swarm-kv.service';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const now = new Date('2026-10-24T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const sec = (d: number) => Math.floor(daysAgo(d).getTime() / 1000);

function fakes(opts: { inFlight?: number; failCollect?: boolean; readOnlyLeft?: boolean; deletesOff?: boolean } = {}) {
  const log: string[] = [];
  const scripts: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let readOnly = false;
  const registry = {
    id: 'svc-reg',
    name: 'swarmy-registry',
    image: 'registry:2@sha256:feed',
    mode: 'replicated',
    runningReplicas: 1,
    labels: { [REGISTRY_AUTH_LABEL]: 'swarmy-registry-htpasswd-x' },
    env: ['REGISTRY_AUTH=htpasswd', ...(opts.deletesOff ? [] : ['REGISTRY_STORAGE_DELETE_ENABLED=true']), ...(opts.readOnlyLeft ? ['REGISTRY_STORAGE_MAINTENANCE_READONLY={"enabled":true}'] : [])],
    mounts: [{ type: 'volume', source: 'swarmy-registry-data', target: '/var/lib/registry' }],
  };
  // The oldest build runs in prod; keepProd is OFF — the registry must still keep it.
  const app = { id: 'svc-app', name: 'shop_app', image: `localhost:5000/app@${D('1')}`, mode: 'replicated', runningReplicas: 1, labels: {} };
  const task = (id: string) => ({ id, serviceId: 'svc-reg', state: 'running', image: registry.image, labels: { 'com.docker.swarm.node.id': 'swarmn2' } });
  const hub = {
    liveInventory: () => ({ services: [registry, app], containers: [task('c-old')] }),
    lastKnownServices: () => [],
    managerNode: () => 'mgr',
    onlineNodeIds: () => ['mgr', 'n2'],
    latestContainers: (n: string) => (n === 'n2' ? [task(readOnly ? 'c-new' : 'c-old')] : []),
    swarmNodeIdFor: () => undefined,
    dispatch: async (node: string, cmd: string, p: { cmd?: string[]; binds?: string[]; spec?: { env?: Record<string, string> } }) => {
      if (cmd === 'service.deploy') {
        readOnly = 'REGISTRY_STORAGE_MAINTENANCE_READONLY' in (p.spec?.env ?? {});
        log.push(`${node}:deploy:${readOnly ? 'ro' : 'rw'}`);
        return {};
      }
      const script = p.cmd?.[0] ?? '';
      scripts.push(script);
      if (p.binds?.[0]?.endsWith(':ro')) {
        log.push(`${node}:scan`);
        return { exitCode: 0, output: `@@SWARMY-REG-UNTAGGED@@ app ${D('c')} ${sec(9)}\n@@SWARMY-REG-STATS@@ 4096 1 3` };
      }
      if (script.includes('garbage-collect')) {
        log.push(`${node}:collect:${readOnly ? 'ro' : 'RW!'}`);
        if (opts.failCollect) throw new Error('agent went away');
        return { exitCode: 0, output: '@@SWARMY-REG-BEFORE@@ 4096\n@@SWARMY-REG-GC@@ 0\n@@SWARMY-REG-STATS@@ 1024 1 2' };
      }
      log.push(`${node}:delete`);
      const refs = [...script.matchAll(/manifest delete 'localhost:5000\/([^']+)'/g)].map((m) => m[1]);
      return { exitCode: 0, output: refs.map((r) => `@@SWARMY-REG-DELETED@@ ${r}`).join('\n') };
    },
  } as unknown as AgentHub;
  const db = {
    build: {
      findMany: async () =>
        [['1', 30], ['2', 20], ['3', 2]].map(([c, d]) => ({ id: `b${c}`, image: `localhost:5000/app@${D(c as string)}`, finishedAt: daysAgo(d as number) })),
      count: async () => opts.inFlight ?? 0,
    },
    auditLog: { create: async (a: { data: Record<string, unknown> }) => void audits.push(a.data) },
  } as unknown as DB;
  seedKv(hub, 'o1', 'registry', 'o1', { enabled: true, host: 'localhost:5000', credentialsEnc: null });
  seedKv(hub, 'o1', 'image-gc', 'o1', { mode: 'KEEP_LAST', keepLast: 1, keepProd: false, days: null, cacheMaxAgeDays: 14, cacheMaxGb: 20 });
  return { deps: { db, hub, auth: {} as Auth }, log, scripts, audits };
}

const opts = { now, sleep: async () => undefined };

describe('runRegistryGcForOrg', () => {
  it('scan → delete via the API → read-only window → garbage-collect → read-write, never the in-prod digest', async () => {
    const f = fakes();
    const r = await runRegistryGcForOrg(f.deps, 'o1', opts);
    expect(f.log).toEqual(['n2:scan', 'mgr:delete', 'mgr:deploy:ro', 'n2:collect:ro', 'mgr:deploy:rw']);
    const del = f.scripts[1] ?? '';
    expect(del).toContain(`app@${D('2')}`); // beyond keep-last 1
    expect(del).toContain(`app@${D('c')}`); // untagged leftover
    expect(del).not.toContain(D('1')); // in prod, even with keepProd off
    expect(del).not.toContain(D('3')); // newest, kept
    expect(r).toMatchObject({ planned: 2, deleted: 2, swept: true, reclaimedBytes: 3072 * 1024 });
    expect(f.audits[0]).toMatchObject({ action: 'cicd.registry.gc', actorType: 'system' });
    expect(getRegistryUsage('o1')).toMatchObject({ sizeBytes: 1024 * 1024, images: 2, lastGc: { deleted: 2 } });
  });

  it('is signature-gated: an unchanged plan sends nothing but the read-only scan', async () => {
    const f = fakes();
    const first = await runRegistryGcForOrg(f.deps, 'o1', opts);
    f.log.length = 0;
    const again = await runRegistryGcForOrg(f.deps, 'o1', { ...opts, state: first.next });
    expect(again.skipped).toBe('unchanged');
    expect(f.log).toEqual(['n2:scan']);
  });

  it('never opens the read-only window while a build is pushing', async () => {
    const f = fakes({ inFlight: 1 });
    const r = await runRegistryGcForOrg(f.deps, 'o1', opts);
    expect(r.skipped).toBe('a build is pushing');
    expect(f.log).toEqual(['n2:scan']);
    expect(r.next).toBeUndefined();
  });

  it('always puts the registry back read-write, and remembers the sweep is pending', async () => {
    const f = fakes({ failCollect: true });
    const r = await runRegistryGcForOrg(f.deps, 'o1', opts);
    expect(f.log.slice(-2)).toEqual(['n2:collect:ro', 'mgr:deploy:rw']);
    expect(r).toMatchObject({ swept: false, error: 'agent went away', next: { pendingSweep: true } });
  });

  it('heals a window an earlier run left read-only before anything else', async () => {
    const f = fakes({ readOnlyLeft: true });
    const r = await runRegistryGcForOrg(f.deps, 'o1', opts);
    expect(f.log).toEqual(['mgr:deploy:rw']);
    expect(r.skipped).toContain('restored read-write');
  });

  it('a registry deployed with deletes off is redeployed with them first (pinned), deletes wait a tick', async () => {
    const f = fakes({ deletesOff: true });
    const r = await runRegistryGcForOrg(f.deps, 'o1', opts);
    expect(f.log).toEqual(['n2:scan', 'mgr:deploy:rw']);
    expect(r.skipped).toContain('turned on manifest deletes');
    expect(r.next).toBeUndefined();
  });

  it('dry run scans and plans, deletes nothing', async () => {
    const f = fakes();
    const r = await runRegistryGcForOrg(f.deps, 'o1', { ...opts, dryRun: true });
    expect(r.planned).toBe(2);
    expect(f.log).toEqual(['n2:scan']);
  });
});
