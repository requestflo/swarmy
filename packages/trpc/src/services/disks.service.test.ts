import { describe, expect, it } from 'bun:test';
import type { ListDisksResult } from '@swarmy/core/protocol';
import {
  chooseDiskAwarePin,
  disksView,
  formatNodeDisk,
  placeOnDefaultDisk,
  recordDiskListing,
  repairNodeDisk,
  resetDiskListings,
  runDiskReconcileFor,
  setDefaultDisk,
  setDiskFormatAllowed,
  unmountedDefaultDiskNodes,
  withDeclaredState,
} from './disks.service';
import { setNodeLabels } from './node.service';

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
  it('formatting is allowed by default and marks the (mounted) default disk', () => {
    const mounted = { ...blank, state: 'swarmy' as const, fstype: 'ext4', mountpoints: ['/var/lib/swarmy/disks/AAAA1111'] };
    const v = disksView('n1', { 'swarmy.disk.AAAA1111': '/var/lib/swarmy/disks/AAAA1111', 'swarmy.disk.default': 'AAAA1111' }, { disks: [mounted] });
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
  it('required: a failed pre-create on a declared default disk throws instead of using the root disk (QA-076)', async () => {
    const g = fakeCtx({ 'swarmy.disk.A': '/var/lib/swarmy/disks/A', 'swarmy.disk.default': 'A' });
    g.ctx.hub.dispatch = async () => { throw new Error('disk not mounted'); };
    await expect(placeOnDefaultDisk(g.ctx, 'sw1', 'v', { required: true })).rejects.toThrow(/default disk.*disk not mounted/);
    // No default disk declared: still a no-op, even when required.
    expect(await placeOnDefaultDisk(fakeCtx().ctx, 'sw1', 'v', { required: true })).toBeNull();
  });
});

// ── QA-075b: a swarmy disk that is formatted but not mounted ─────────────────

const MNT = '/var/lib/swarmy/disks/AAAA1111';
const declared = { 'swarmy.disk.AAAA1111': MNT, 'swarmy.disk.default': 'AAAA1111' };
const unattached = {
  ...blank, state: 'swarmy-unmounted' as const, fstype: 'ext4', reason: 'Formatted by swarmy, but not attached',
  pending: { files: 12, bytes: 3 * GB, services: ['shop_db-primary', 'shop_web'] },
};

describe('disksView: only a really mounted disk takes new data (QA-075b)', () => {
  it('isDefault only when the declared default is mounted; a warning otherwise', () => {
    const v = disksView('n1', declared, { disks: [unattached] });
    expect(v.disks[0]!.isDefault).toBe(false);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatchObject({ diskId: 'AAAA1111', kind: 'unmounted', isDefault: true });
    expect(v.warnings[0]!.message).toContain('not attached');
    expect(v.warnings[0]!.message).toContain('3.0 GB');
    const ok = disksView('n1', declared, { disks: [{ ...blank, state: 'swarmy', mountpoints: [MNT] }] });
    expect(ok.disks[0]!.isDefault).toBe(true);
    expect(ok.warnings).toEqual([]);
  });
  it('a declared disk that is not connected at all is warned about too', () => {
    expect(disksView('n1', declared, { disks: [] }).warnings[0]).toMatchObject({ kind: 'missing', name: null });
  });
});

function repairCtx(opts: { repairFails?: string; scaleFails?: string; services?: any[]; noManager?: boolean } = {}) {
  const f = fakeCtx(declared);
  const hub = f.ctx.hub;
  hub.managerNode = () => (opts.noManager ? undefined : 'n2');
  hub.liveInventory = () => ({
    services: opts.services ?? [
      { name: 'shop_db-primary', mode: 'replicated', desiredReplicas: 1 },
      { name: 'shop_web', mode: 'replicated', desiredReplicas: 3 },
    ],
    containers: [],
  });
  hub.dispatch = async (node: string, cmd: string, payload: any) => {
    f.calls.push({ node, cmd, payload });
    if (cmd === 'disk.list') return { disks: [unattached] };
    if (cmd === 'service.scale' && opts.scaleFails === payload.service && payload.replicas === 0) throw new Error('scale failed');
    if (cmd === 'disk.repair') {
      if (opts.repairFails) throw new Error(opts.repairFails);
      return { serial: 'AAAA1111', id: 'AAAA1111', mountpoint: MNT, alreadyMounted: false, uuid: 'u-1', moved: true, files: 12, bytes: 3 * GB, aside: `${MNT}.pre-mount-x` };
    }
    return {};
  };
  return f;
}

const steps = (f: { calls: { cmd: string; payload: any }[] }) =>
  f.calls.filter((c) => c.cmd !== 'disk.list').map((c) => (c.cmd === 'service.scale' ? `scale ${c.payload.service}=${c.payload.replicas}` : c.cmd));

describe('repairNodeDisk', () => {
  it('stops the apps on the disk, re-attaches it, starts them again, and audits every step', async () => {
    const f = repairCtx();
    const r = await repairNodeDisk(f.ctx, { nodeId: 'n1', serial: 'AAAA1111' });
    expect(r).toMatchObject({ moved: true, bytes: 3 * GB, services: ['shop_db-primary', 'shop_web'], restartErrors: [] });
    expect(steps(f)).toEqual(['scale shop_db-primary=0', 'scale shop_web=0', 'disk.repair', 'scale shop_db-primary=1', 'scale shop_web=3']);
    expect(f.calls.find((c) => c.cmd === 'disk.repair')!).toMatchObject({ node: 'n1', payload: { path: '/dev/sdb', serial: 'AAAA1111', nodeCapable: true } });
    expect(f.calls.filter((c) => c.cmd === 'service.scale').every((c) => c.node === 'n2')).toBe(true);
    expect(f.audits.map((a) => a.action)).toEqual([
      'node.disk.repair.start', 'node.disk.repair.stopped', 'node.disk.repair.done', 'node.disk.repair.restarted',
    ]);
    expect(f.audits[2].metadata).toMatchObject({ moved: true, bytes: 3 * GB });
  });

  it('ALWAYS scales the apps back when the repair fails', async () => {
    const f = repairCtx({ repairFails: 'the copy on the disk does not match the originals' });
    await expect(repairNodeDisk(f.ctx, { nodeId: 'n1', serial: 'AAAA1111' })).rejects.toThrow(/does not match/);
    expect(steps(f)).toEqual(['scale shop_db-primary=0', 'scale shop_web=0', 'disk.repair', 'scale shop_db-primary=1', 'scale shop_web=3']);
    expect(f.audits.map((a) => a.action)).toEqual([
      'node.disk.repair.start', 'node.disk.repair.stopped', 'node.disk.repair.failed', 'node.disk.repair.restarted',
    ]);
  });

  it('a failed scale-down still scales back what it touched, and never repairs', async () => {
    const f = repairCtx({ scaleFails: 'shop_web' });
    await expect(repairNodeDisk(f.ctx, { nodeId: 'n1', serial: 'AAAA1111' })).rejects.toThrow(/scale failed/);
    expect(steps(f)).toEqual(['scale shop_db-primary=0', 'scale shop_web=0', 'scale shop_db-primary=1', 'scale shop_web=3']);
  });

  it('aborts on a global service, before stopping anything', async () => {
    const f = repairCtx({ services: [{ name: 'shop_db-primary', mode: 'global' }, { name: 'shop_web', mode: 'replicated', desiredReplicas: 1 }] });
    await expect(repairNodeDisk(f.ctx, { nodeId: 'n1', serial: 'AAAA1111' })).rejects.toThrow(/runs on every server/);
    expect(steps(f)).toEqual([]);
    expect(f.audits.at(-1).action).toBe('node.disk.repair.failed');
  });

  it('refuses a disk the node does not declare, or when repair is turned off for the server', async () => {
    const f = repairCtx();
    await expect(repairNodeDisk(f.ctx, { nodeId: 'n1', serial: 'ZZZZ9999' })).rejects.toThrow(/not one swarmy set up/);
    f.nodeLabels['swarmy.node.diskRepair'] = 'false';
    await expect(repairNodeDisk(f.ctx, { nodeId: 'n1', serial: 'AAAA1111' })).rejects.toThrow(/turned off/);
    expect(steps(f)).toEqual([]);
  });
});

describe('placement skips a server whose data disk is not attached (QA-075b)', () => {
  it('unmountedDefaultDiskNodes follows the last listing; chooseDiskAwarePin skips, notes, and refuses only when none is left', async () => {
    resetDiskListings();
    const hub: any = {
      onlineNodeIds: () => ['n1', 'n2'],
      swarmNodeIdFor: (n: string) => ({ n1: 'sw1', n2: 'sw2' })[n],
      nodeInventory: () => [
        { swarmNodeId: 'sw1', role: 'worker', availability: 'active', status: 'ready', labels: declared },
        { swarmNodeId: 'sw2', role: 'manager', availability: 'active', status: 'ready', labels: {} },
      ],
    };
    // Never listed ⇒ unknown ⇒ not skipped: the disk node wins as before.
    expect(unmountedDefaultDiskNodes(hub, 'org1').size).toBe(0);
    expect(chooseDiskAwarePin({ hub, activeOrgId: 'org1' }, new Map(), 'sw2')).toBe('sw1');

    recordDiskListing('n1', [unattached]);
    expect([...unmountedDefaultDiskNodes(hub, 'org1')]).toEqual(['sw1']);
    const audits: any[] = [];
    const db: any = { auditLog: { create: async ({ data }: any) => audits.push(data) } };
    expect(chooseDiskAwarePin({ hub, activeOrgId: 'org1', db }, new Map(), 'sw2')).toBe('sw2');
    await Promise.resolve();
    expect(audits[0]).toMatchObject({ action: 'data.placement.skip' });
    expect(audits[0].metadata.note).toContain('skipped sw1');

    hub.nodeInventory = () => [{ swarmNodeId: 'sw1', role: 'worker', availability: 'active', status: 'ready', labels: declared }];
    expect(() => chooseDiskAwarePin({ hub, activeOrgId: 'org1' }, new Map(), 'sw1')).toThrow(/no server can take the data right now/);

    // Mounted again ⇒ eligible again.
    recordDiskListing('n1', [{ ...blank, state: 'swarmy', mountpoints: [MNT] }]);
    expect(chooseDiskAwarePin({ hub, activeOrgId: 'org1' }, new Map(), 'sw1')).toBe('sw1');
    resetDiskListings();
  });
});

// ── QA-085: a disk back after a reboot, not mounted ──────────────────────────

describe('a returning disk (QA-085)', () => {
  it('a declared disk with swarmy’s label is never has-data, whatever the agent said', () => {
    const hasData = { ...blank, state: 'has-data' as const, fstype: 'ext4', label: 'swarmy-AAAA1111', reason: 'Has a ext4 filesystem' };
    const fixed = withDeclaredState({ disks: [hasData] }, declared);
    expect(fixed.disks[0]!.state).toBe('swarmy-unmounted');
    // Undeclared, someone else's label, or mounted somewhere: left alone.
    expect(withDeclaredState({ disks: [hasData] }, {}).disks[0]!.state).toBe('has-data');
    expect(withDeclaredState({ disks: [{ ...hasData, label: 'data' }] }, declared).disks[0]!.state).toBe('has-data');
    expect(withDeclaredState({ disks: [{ ...hasData, mountpoints: ['/mnt/x'] }] }, declared).disks[0]!.state).toBe('has-data');
  });

  it('a MISSING default disk is a warning, not silently dropped', () => {
    const v = disksView('n1', declared, { disks: [{ ...blank, name: 'sda', serial: 'root', id: 'root', state: 'system' }] });
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatchObject({ kind: 'missing', isDefault: true, diskId: 'AAAA1111' });
    expect(v.warnings[0]!.message).toContain("Your default disk isn't attached to this server");
    expect(v.disks.some((d) => d.isDefault)).toBe(false);
  });

  it('an empty mountpoint re-attaches with NO scale-down when nothing is running on it', async () => {
    const f = repairCtx();
    const empty = { ...unattached, pending: { files: 0, bytes: 0, services: ['shop_db-primary'], running: [] as string[] } };
    f.ctx.hub.dispatch = async (node: string, cmd: string, payload: any) => {
      f.calls.push({ node, cmd, payload });
      if (cmd === 'disk.list') return { disks: [empty] };
      if (cmd === 'disk.repair') return { serial: 'AAAA1111', id: 'AAAA1111', mountpoint: MNT, alreadyMounted: false, uuid: 'u-1', moved: false, files: 0, bytes: 0, aside: null };
      return {};
    };
    const r = await repairNodeDisk(f.ctx, { nodeId: 'n1', serial: 'AAAA1111' });
    expect(r).toMatchObject({ moved: false, services: [] });
    expect(steps(f)).toEqual(['disk.repair']);
    expect(f.audits.map((a) => a.action)).toEqual(['node.disk.repair.start', 'node.disk.repair.done']);
  });

  it('the worker path re-attaches a declared empty-dir disk it finds', async () => {
    const f = repairCtx();
    const empty = { ...unattached, pending: { files: 0, bytes: 0, services: [], running: [] } };
    f.ctx.hub.dispatch = async (node: string, cmd: string, payload: any) => {
      f.calls.push({ node, cmd, payload });
      if (cmd === 'disk.list') return { disks: [empty] };
      if (cmd === 'disk.repair') return { serial: 'AAAA1111', id: 'AAAA1111', mountpoint: MNT, alreadyMounted: false, uuid: 'u-1', moved: false, files: 0, bytes: 0, aside: null };
      return {};
    };
    const out = await runDiskReconcileFor(f.ctx, 'n1');
    expect(out).toMatchObject({ repaired: ['AAAA1111'], failed: [] });
    expect(f.audits[0].actorType).toBe('system');
  });
});

// ── QA-086: choosing the default disk ────────────────────────────────────────

describe('setDefaultDisk / setLabels guard (QA-086)', () => {
  const B = '/var/lib/swarmy/disks/BBBB2222';
  const two = [
    { ...blank, state: 'swarmy' as const, fstype: 'ext4', mountpoints: [MNT] },
    { ...blank, name: 'sdc', path: '/dev/sdc', serial: 'BBBB2222', id: 'BBBB2222', state: 'swarmy' as const, fstype: 'ext4', mountpoints: [B] },
    { ...blank, name: 'sdd', path: '/dev/sdd', serial: 'CCCC3333', id: 'CCCC3333', state: 'swarmy-unmounted' as const, fstype: 'ext4' },
  ];
  function ctxWithDisks() {
    const f = fakeCtx({ ...declared, 'swarmy.disk.BBBB2222': B });
    const orig = f.ctx.hub.dispatch;
    f.ctx.hub.dispatch = async (node: string, cmd: string, payload: any) => (cmd === 'disk.list' ? (f.calls.push({ node, cmd, payload }), { disks: two }) : orig(node, cmd, payload));
    return f;
  }

  it('moves the default to another mounted swarmy disk, via a manager, audited', async () => {
    const f = ctxWithDisks();
    expect(await setDefaultDisk(f.ctx, { nodeId: 'n1', diskId: 'BBBB2222' })).toEqual({ nodeId: 'n1', diskId: 'BBBB2222', mountpoint: B, previous: 'AAAA1111' });
    expect(f.nodeLabels['swarmy.disk.default']).toBe('BBBB2222');
    expect(f.calls.find((c) => c.cmd === 'node.update')!.node).toBe('n2');
    expect(f.audits.at(-1)).toMatchObject({ action: 'node.disk.setDefault', metadata: { diskId: 'BBBB2222', previous: 'AAAA1111' } });
  });

  it('refuses an unknown or unmounted disk', async () => {
    const f = ctxWithDisks();
    await expect(setDefaultDisk(f.ctx, { nodeId: 'n1', diskId: 'nope' })).rejects.toThrow(/no disk nope/);
    await expect(setDefaultDisk(f.ctx, { nodeId: 'n1', diskId: 'CCCC3333' })).rejects.toThrow(/not a mounted swarmy disk/);
    expect(f.nodeLabels['swarmy.disk.default']).toBe('AAAA1111');
  });

  it('nodes.setLabels rejects a bad swarmy.disk.default or disk mountpoint, and allows a good one', async () => {
    const f = ctxWithDisks();
    await expect(setNodeLabels(f.ctx, 'n1', { 'swarmy.disk.default': 'whatever' })).rejects.toThrow(/disks.setDefault/);
    await expect(setNodeLabels(f.ctx, 'n1', { 'swarmy.disk.X1': '/tmp' })).rejects.toThrow(/must be \/var\/lib\/swarmy\/disks\/X1/);
    expect(f.calls.some((c) => c.cmd === 'node.update')).toBe(false);
    await setNodeLabels(f.ctx, 'n1', { 'swarmy.disk.default': 'BBBB2222' });
    expect(f.nodeLabels['swarmy.disk.default']).toBe('BBBB2222');
  });
});
