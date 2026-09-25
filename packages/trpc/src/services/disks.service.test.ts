import { describe, expect, it } from 'bun:test';
import type { ListDisksResult } from '@swarmy/core/protocol';
import { disksView, formatNodeDisk, placeOnDefaultDisk, setDiskFormatAllowed } from './disks.service';

const GB = 1024 ** 3;
const blank = {
  name: 'sdb', path: '/dev/sdb', sizeBytes: 100 * GB, serial: 'AAAA1111', model: 'Volume', state: 'blank' as const,
  mountpoints: [], fstype: null, reason: 'New and empty', id: 'AAAA1111', fsTotalBytes: null, growableBytes: 0,
};

function fakeCtx(labels: Record<string, string> = {}, opts: { formatFails?: string } = {}) {
  const calls: { node: string; cmd: string; payload: any }[] = [];
  const audits: any[] = [];
  const nodeLabels = { ...labels };
  const hub: any = {
    isOnline: () => true,
    onlineNodeIds: () => ['n1', 'n2'],
    swarmNodeIdFor: (n: string) => ({ n1: 'sw1', n2: 'sw2' })[n],
    nodeInfoFor: (n: string) => (n === 'n1' ? { labels: nodeLabels } : { labels: {} }),
    managerNode: () => 'n2',
    dispatch: async (node: string, cmd: string, payload: any) => {
      calls.push({ node, cmd, payload });
      if (cmd === 'disk.format') {
        if (opts.formatFails) throw new Error(opts.formatFails);
        return { serial: payload.serial, id: 'AAAA1111', mountpoint: '/var/lib/swarmy/disks/AAAA1111', uuid: 'u-1', sizeBytes: payload.sizeBytes };
      }
      if (cmd === 'node.update') Object.assign(nodeLabels, payload.labels);
      return {};
    },
  };
  const db: any = {
    node: { findFirst: async ({ where }: any) => (where.id === 'n1' && where.orgId === 'org1' ? { id: 'n1' } : null) },
    auditLog: { create: async ({ data }: any) => audits.push(data) },
  };
  return { ctx: { hub, db, activeOrgId: 'org1', user: { id: 'u1' } } as any, calls, audits, nodeLabels };
}

describe('disksView', () => {
  const listed: ListDisksResult = { disks: [blank] };
  it('formatting is allowed by default and marks the default disk', () => {
    const v = disksView('n1', { 'swarmy.disk.AAAA1111': '/var/lib/swarmy/disks/AAAA1111', 'swarmy.disk.default': 'AAAA1111' }, listed);
    expect(v.formatAllowed).toBe(true);
    expect(v.disks[0]!.isDefault).toBe(true);
  });
  it('the node label or the box override turns it off, with a reason', () => {
    expect(disksView('n1', { 'swarmy.node.diskFormat': 'false' }, listed).formatBlockedReason).toContain('turned off');
    expect(disksView('n1', {}, { ...listed, localOverride: 'deny' }).formatBlockedReason).toContain('SWARMY_ALLOW_DISK_FORMAT');
  });
});

describe('formatNodeDisk', () => {
  it('asserts the node capability, labels the node via a manager (first disk = default) and audits', async () => {
    const f = fakeCtx();
    const r = await formatNodeDisk(f.ctx, { nodeId: 'n1', path: '/dev/sdb', serial: 'AAAA1111', sizeBytes: 100 * GB, confirm: '1111' });
    expect(r.isDefault).toBe(true);
    const fmt = f.calls.find((c) => c.cmd === 'disk.format')!;
    expect(fmt.node).toBe('n1');
    expect(fmt.payload).toMatchObject({ nodeCapable: true, typedConfirmation: '1111', fstype: 'ext4' });
    const upd = f.calls.find((c) => c.cmd === 'node.update')!;
    expect(upd.node).toBe('n2'); // node labels are manager-only
    expect(f.nodeLabels).toMatchObject({ 'swarmy.disk.AAAA1111': '/var/lib/swarmy/disks/AAAA1111', 'swarmy.disk.default': 'AAAA1111' });
    expect(f.audits.at(-1)).toMatchObject({ action: 'node.disk.format', targetId: 'n1' });
    expect(f.audits.at(-1).metadata.outcome).toBe('formatted');
  });

  it('refuses on an opted-out node without dispatching', async () => {
    const f = fakeCtx({ 'swarmy.node.diskFormat': 'false' });
    await expect(formatNodeDisk(f.ctx, { nodeId: 'n1', path: '/dev/sdb', serial: 'AAAA1111', sizeBytes: 1, confirm: '1111' })).rejects.toThrow(/turned off/);
    expect(f.calls).toEqual([]);
  });

  it('audits an agent refusal and passes its reason through', async () => {
    const f = fakeCtx({}, { formatFails: 'The confirmation does not match the last 4 characters of the disk serial.' });
    await expect(formatNodeDisk(f.ctx, { nodeId: 'n1', path: '/dev/sdb', serial: 'AAAA1111', sizeBytes: 1, confirm: 'zzzz' })).rejects.toThrow(/confirmation/);
    expect(f.audits.at(-1).metadata.outcome).toBe('refused');
    expect(f.calls.some((c) => c.cmd === 'node.update')).toBe(false);
  });

  it('another org’s node is not found', async () => {
    const f = fakeCtx();
    await expect(formatNodeDisk(f.ctx, { nodeId: 'nX', path: '/dev/sdb', serial: 'AAAA1111', sizeBytes: 1, confirm: '1111' })).rejects.toThrow(/not found/);
  });
});

describe('setDiskFormatAllowed', () => {
  it('writes the opt-out label and audits', async () => {
    const f = fakeCtx();
    await setDiskFormatAllowed(f.ctx, { nodeId: 'n1', allowed: false });
    expect(f.nodeLabels['swarmy.node.diskFormat']).toBe('false');
    expect(f.audits.at(-1).action).toBe('node.disk.formatAllowed');
  });
});

describe('placeOnDefaultDisk', () => {
  it('pre-creates the volume on the pinned node’s default disk', async () => {
    const f = fakeCtx({ 'swarmy.disk.AAAA1111': '/var/lib/swarmy/disks/AAAA1111', 'swarmy.disk.default': 'AAAA1111' });
    const dev = await placeOnDefaultDisk(f.ctx, 'sw1', 'shop_db-primary-data');
    expect(dev).toBe('/var/lib/swarmy/disks/AAAA1111/volumes/shop_db-primary-data');
    expect(f.calls).toEqual([
      { node: 'n1', cmd: 'volume.provision', payload: { spec: { name: 'shop_db-primary-data', mode: 'local', options: { type: 'none', o: 'bind', device: dev } } } },
    ]);
  });
  it('is a no-op without a default disk, an unknown node, or on failure', async () => {
    const f = fakeCtx();
    expect(await placeOnDefaultDisk(f.ctx, 'sw1', 'v')).toBeNull();
    expect(await placeOnDefaultDisk(f.ctx, undefined, 'v')).toBeNull();
    expect(await placeOnDefaultDisk(f.ctx, 'swZ', 'v')).toBeNull();
    expect(f.calls).toEqual([]);
    const g = fakeCtx({ 'swarmy.disk.A': '/var/lib/swarmy/disks/A', 'swarmy.disk.default': 'A' });
    g.ctx.hub.dispatch = async () => { throw new Error('disk not mounted'); };
    expect(await placeOnDefaultDisk(g.ctx, 'sw1', 'v')).toBeNull();
  });
});
