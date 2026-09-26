import { describe, expect, it } from 'bun:test';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { provisionDb } from './manageddb.service';

// QA-076: a new managed Postgres ignored the default disk (on lon1-b) and
// landed on lon1-a's root disk. The primary must pin to the disk's node and
// its data volume must be pre-created as a bind under the disk mount.

const DISK = { 'swarmy.disk.vol1': '/var/lib/swarmy/disks/vol1', 'swarmy.disk.default': 'vol1' };
const node = (id: string, over: Partial<SwarmNodeInfo> = {}): SwarmNodeInfo =>
  ({ swarmNodeId: id, hostname: id, role: 'worker', status: 'ready', availability: 'active', labels: {}, ...over }) as SwarmNodeInfo;

function world(opts: { provisionFails?: boolean } = {}) {
  const nodes = [node('lon1-a', { role: 'manager' }), node('lon1-b', { labels: DISK })];
  const byController: Record<string, SwarmNodeInfo> = { node1: nodes[0]!, node2: nodes[1]! };
  const calls: Array<{ node: string; cmd: string; payload: Record<string, unknown> }> = [];
  const hub = {
    managerNode: () => 'node1',
    isOnline: () => true,
    onlineNodeIds: () => ['node1', 'node2'],
    latestContainers: () => [],
    nodeInventory: () => nodes,
    nodeInfoFor: (id: string) => byController[id],
    swarmNodeIdFor: (id: string) => byController[id]?.swarmNodeId ?? 'lon1-a',
    liveInventory: () => ({ services: [], containers: [] }),
    dispatch: (n: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ node: n, cmd, payload });
      if (cmd === 'volume.provision' && opts.provisionFails) return Promise.reject(new Error('/var/lib/swarmy/disks/vol1 is not mounted'));
      return Promise.resolve({});
    },
  };
  const ctx = {
    db: { auditLog: { create: () => Promise.resolve({}) } },
    hub,
    user: null,
    activeOrgId: 'org1',
    membership: { role: 'owner', orgId: 'org1' },
  } as unknown as OrgContext;
  return { ctx, calls };
}

describe('provisionDb — honours the default disk (QA-076)', () => {
  it('pins the primary to the disk node and pre-creates its volume on the disk mount', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: 'shop', name: 'main', replicas: 0, autoBackup: false });
    const vol = w.calls.find((c) => c.cmd === 'volume.provision');
    expect(vol?.node).toBe('node2');
    expect(vol?.payload).toEqual({
      spec: {
        name: 'shop_main-primary-data',
        mode: 'local',
        options: { type: 'none', o: 'bind', device: '/var/lib/swarmy/disks/vol1/volumes/shop_main-primary-data' },
      },
    });
    const primary = w.calls.find(
      (c) => c.cmd === 'service.deploy' && (c.payload.spec as { name: string }).name === 'shop_main-primary',
    );
    const spec = primary?.payload.spec as { placement?: { constraints?: string[] }; labels: Record<string, string> };
    expect(spec.placement?.constraints).toContain('node.id==lon1-b');
    expect(spec.labels['swarmy.db.node']).toBe('lon1-b');
    // The volume exists before the primary is deployed.
    expect(w.calls.indexOf(vol!)).toBeLessThan(w.calls.indexOf(primary!));
  });

  it('refuses rather than silently landing on the root disk when the disk pre-create fails', async () => {
    const w = world({ provisionFails: true });
    await expect(provisionDb(w.ctx, { stack: 'shop', name: 'main', replicas: 0, autoBackup: false })).rejects.toThrow(
      /default disk.*not mounted/,
    );
    expect(w.calls.some((c) => c.cmd === 'service.deploy')).toBe(false);
  });
});
