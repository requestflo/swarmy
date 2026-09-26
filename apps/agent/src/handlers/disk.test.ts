import { describe, expect, it } from 'bun:test';
import type { FormatDiskPayload } from '@swarmy/core/protocol';
import { ensureDiskVolumeDir, formatDisk, growDisk, listDisks, mountReturningDisks, repairDisk, type DiskDeps, type DiskUser } from './disk';
import { agentErrorCode } from '../executor';

const GB = 1024 ** 3;
const CMD = '00000000-0000-4000-8000-000000000032';
const sdb = (over: Record<string, unknown> = {}) => ({
  name: 'sdb', path: '/dev/sdb', size: 100 * GB, type: 'disk', fstype: null, mountpoints: [null],
  serial: '12345678', model: 'Volume', ro: false, rm: false, pttype: null, ...over,
});
const probeOut = (dev: Record<string, unknown>, opts: { wipefs?: string; blkidRc?: number; df?: string } = {}) =>
  [
    '__SWARMY_LSBLK__',
    JSON.stringify({ blockdevices: [dev] }),
    '__SWARMY_DF__',
    opts.df ?? '',
    '__SWARMY_WIPEFS__',
    opts.wipefs ?? '',
    '__SWARMY_BLKID__',
    `__SWARMY_BLKID_RC__ ${opts.blkidRc ?? 2}`,
    '',
  ].join('\n');

/** A scripted host: answers the probe, records every script it was asked to run. */
function host(probe: string, formatOut = '__SWARMY_FORMATTED__ 1111-2222\n', override?: 'allow' | 'deny') {
  const scripts: string[] = [];
  const deps: DiskDeps = {
    override,
    runHost: async (script) => {
      scripts.push(script);
      if (script.includes('mkfs.ext4 -q')) return { code: formatOut.includes('__SWARMY_ERR__') ? 3 : 0, out: formatOut };
      if (script.includes('resize2fs')) return { code: 0, out: `__SWARMY_GROWN__ ${200 * GB}\n` };
      return { code: 0, out: probe };
    },
  };
  return { deps, scripts, formatted: () => scripts.some((s) => s.includes('mkfs.ext4 -q')) };
}

const payload = (over: Partial<FormatDiskPayload> = {}): FormatDiskPayload => ({
  commandId: CMD, path: '/dev/sdb', serial: '12345678', sizeBytes: 100 * GB, typedConfirmation: '5678', fstype: 'ext4', nodeCapable: true, ...over,
});

describe('formatDisk', () => {
  it('formats a blank disk after a fresh probe and reports where it is mounted', async () => {
    const h = host(probeOut(sdb()));
    const r = await formatDisk(h.deps, payload());
    expect(r).toEqual({ serial: '12345678', id: '12345678', mountpoint: '/var/lib/swarmy/disks/12345678', uuid: '1111-2222', sizeBytes: 100 * GB });
    expect(h.scripts[0]).toContain("wipefs -n '/dev/sdb'");
  });

  it('refuses when the node opted out, locally or by label — before touching the host', async () => {
    const h = host(probeOut(sdb()));
    await expect(formatDisk(h.deps, payload({ nodeCapable: false }))).rejects.toMatchObject({ code: 'E_DISK_FORMAT_DISABLED' });
    await expect(formatDisk(h.deps, payload({ nodeCapable: undefined }))).rejects.toMatchObject({ code: 'E_DISK_FORMAT_DISABLED' });
    const denied = host(probeOut(sdb()), undefined, 'deny');
    await expect(formatDisk(denied.deps, payload())).rejects.toThrow(/SWARMY_ALLOW_DISK_FORMAT=false/);
    expect(h.scripts).toEqual([]);
    expect(denied.scripts).toEqual([]);
  });

  it('never formats a disk with a signature, a wrong confirmation, a changed serial or size', async () => {
    const cases: [string, Partial<FormatDiskPayload>][] = [
      [probeOut(sdb(), { wipefs: 'DEVICE OFFSET TYPE\nsdb 0x438 ext4' }), {}],
      [probeOut(sdb(), { blkidRc: 0 }), {}],
      [probeOut(sdb(), { blkidRc: 4 }), {}],
      [probeOut(sdb({ fstype: 'xfs' })), {}],
      [probeOut(sdb({ serial: 'ffff0000' })), {}],
      [probeOut(sdb()), { typedConfirmation: '1234' }],
      [probeOut(sdb()), { sizeBytes: 50 * GB }],
      // Probe output without the signature section at all ⇒ refused.
      [probeOut(sdb()).split('__SWARMY_WIPEFS__')[0]!, {}],
    ];
    for (const [out, over] of cases) {
      const h = host(out);
      await expect(formatDisk(h.deps, payload(over))).rejects.toMatchObject({ code: 'E_DISK_REFUSED' });
      expect(h.formatted()).toBe(false);
    }
  });

  it("surfaces the format script's own refusal", async () => {
    const h = host(probeOut(sdb()), '__SWARMY_ERR__ /dev/sdb is now a different disk (serial changed)\n');
    await expect(formatDisk(h.deps, payload())).rejects.toMatchObject({ code: 'E_DISK_FORMAT', message: '/dev/sdb is now a different disk (serial changed)' });
  });
});

describe('listDisks / growDisk', () => {
  const grown = probeOut(sdb({ size: 200 * GB, fstype: 'ext4', mountpoints: ['/var/lib/swarmy/disks/12345678'] }), {
    df: `/var/lib/swarmy/disks/12345678 ${100 * GB}`,
  });

  it('lists classified disks with room to grow and the local override', async () => {
    const r = await listDisks(host(grown, undefined, 'deny').deps);
    expect(r.localOverride).toBe('deny');
    expect(r.disks[0]).toMatchObject({ state: 'swarmy', growableBytes: 100 * GB, fsTotalBytes: 100 * GB });
  });

  it('a missing lsblk is a clear error', async () => {
    const h: DiskDeps = { override: undefined, runHost: async () => ({ code: 3, out: '__SWARMY_ERR__ lsblk is not installed on this server\n' }) };
    await expect(listDisks(h)).rejects.toThrow('lsblk is not installed');
  });

  it('grows only a swarmy disk that outgrew its filesystem', async () => {
    const h = host(grown);
    expect(await growDisk(h.deps, { commandId: CMD, serial: '12345678' })).toEqual({
      serial: '12345678', mountpoint: '/var/lib/swarmy/disks/12345678', fsTotalBytes: 200 * GB,
    });
    const full = host(probeOut(sdb({ fstype: 'ext4', mountpoints: ['/var/lib/swarmy/disks/12345678'] }), { df: `/var/lib/swarmy/disks/12345678 ${100 * GB}` }));
    await expect(growDisk(full.deps, { commandId: CMD, serial: '12345678' })).rejects.toThrow(/already fills/);
    await expect(growDisk(host(probeOut(sdb())).deps, { commandId: CMD, serial: '12345678' })).rejects.toThrow(/no swarmy disk/);
  });
});

describe('disk volume dir + error codes', () => {
  it('refuses to place a volume when the disk is not mounted', async () => {
    await expect(
      ensureDiskVolumeDir(async () => ({ code: 3, out: '__SWARMY_ERR__ /var/lib/swarmy/disks/A is not mounted\n' }), '/var/lib/swarmy/disks/A/volumes/v'),
    ).rejects.toMatchObject({ code: 'E_DISK_NOT_MOUNTED' });
    await ensureDiskVolumeDir(async () => ({ code: 0, out: '__SWARMY_OK__\n' }), '/var/lib/swarmy/disks/A/volumes/v');
  });

  it('keeps handler E_* codes, maps everything else to E_DOCKER', () => {
    expect(agentErrorCode(Object.assign(new Error('x'), { code: 'E_DISK_REFUSED' }))).toBe('E_DISK_REFUSED');
    expect(agentErrorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('E_DOCKER');
    expect(agentErrorCode('boom')).toBe('E_DOCKER');
  });
});

describe('repairDisk / pending (QA-075b)', () => {
  const MNT = '/var/lib/swarmy/disks/12345678';
  const unmounted = probeOut(sdb({ fstype: 'ext4', label: 'swarmy-12345678' }));
  const repairOk = `__SWARMY_REPAIRED__ uuid=u-1 moved=1 files=3 bytes=4096 aside=${MNT}.pre-mount-S1\n`;

  function repairHost(probe: string, opts: { repairOut?: string; users?: DiskUser[][]; allowed?: boolean } = {}) {
    const scripts: string[] = [];
    let call = 0;
    let t = 0;
    const deps: DiskDeps = {
      override: undefined,
      repairAllowed: opts.allowed,
      runHost: async (script) => {
        scripts.push(script);
        if (script.includes('rsync -aHAX')) return { code: opts.repairOut?.includes('__SWARMY_ERR__') ? 3 : 0, out: opts.repairOut ?? repairOk };
        if (script.includes('__SWARMY_PENDING__')) return { code: 0, out: `__SWARMY_PENDING__ ${MNT} 3 4096\n` };
        return { code: 0, out: probe };
      },
      users: async () => opts.users?.[Math.min(call++, opts.users.length - 1)] ?? [],
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
    };
    return { deps, scripts, repaired: () => scripts.some((s) => s.includes('rsync -aHAX')) };
  }
  const rp = { commandId: CMD, path: '/dev/sdb', serial: '12345678', stamp: 'S1', waitMs: 10_000 };

  it('lists an unattached swarmy disk with what is pending on the root disk and who uses it', async () => {
    const h = repairHost(unmounted, { users: [[{ container: 'shop_db-primary.1.x', service: 'shop_db-primary', running: true }]] });
    const r = await listDisks(h.deps);
    expect(r.disks[0]).toMatchObject({ state: 'swarmy-unmounted', pending: { files: 3, bytes: 4096, services: ['shop_db-primary'] } });
  });

  it('re-attaches once nothing is running on the disk', async () => {
    const busyThenFree: DiskUser[][] = [[{ container: 'c1', service: 'shop_db-primary', running: true }], [{ container: 'c1', service: 'shop_db-primary', running: false }]];
    const h = repairHost(unmounted, { users: busyThenFree });
    expect(await repairDisk(h.deps, rp)).toEqual({
      serial: '12345678', id: '12345678', mountpoint: MNT, alreadyMounted: false, uuid: 'u-1', moved: true, files: 3, bytes: 4096, aside: `${MNT}.pre-mount-S1`,
    });
  });

  it('E_DISK_BUSY when a container keeps running; nothing is copied', async () => {
    const h = repairHost(unmounted, { users: [[{ container: 'web-1', running: true }]] });
    await expect(repairDisk(h.deps, rp)).rejects.toMatchObject({ code: 'E_DISK_BUSY', message: expect.stringContaining('web-1') });
    expect(h.repaired()).toBe(false);
  });

  it('already mounted is a no-op; a non-swarmy disk, a moved device or the local veto are refused', async () => {
    const mounted = repairHost(probeOut(sdb({ fstype: 'ext4', label: 'swarmy-12345678', mountpoints: [MNT] })));
    expect(await repairDisk(mounted.deps, rp)).toMatchObject({ alreadyMounted: true, moved: false });
    expect(mounted.repaired()).toBe(false);
    await expect(repairDisk(repairHost(probeOut(sdb({ fstype: 'ext4', label: 'data' }))).deps, rp)).rejects.toMatchObject({ code: 'E_DISK_REFUSED' });
    await expect(repairDisk(repairHost(unmounted).deps, { ...rp, path: '/dev/sdc' })).rejects.toMatchObject({ code: 'E_DISK_REFUSED' });
    await expect(repairDisk(repairHost(unmounted, { allowed: false }).deps, rp)).rejects.toMatchObject({ code: 'E_DISK_REPAIR_DISABLED' });
    await expect(repairDisk(repairHost(unmounted).deps, { ...rp, nodeCapable: false })).rejects.toMatchObject({ code: 'E_DISK_REPAIR_DISABLED' });
  });

  it("surfaces the repair script's own error", async () => {
    const h = repairHost(unmounted, { repairOut: '__SWARMY_ERR__ the copy on the disk does not match the originals\n__SWARMY_ROLLED_BACK__\n' });
    await expect(repairDisk(h.deps, rp)).rejects.toMatchObject({ code: 'E_DISK_REPAIR', message: 'the copy on the disk does not match the originals' });
  });
});

describe('mountReturningDisks at agent start (QA-085)', () => {
  const MNT = '/var/lib/swarmy/disks/12345678';
  const back = probeOut(sdb({ fstype: 'ext4', label: 'swarmy-12345678' }));
  function startHost(pendingLine: string, users: DiskUser[] = [], repairOut = `__SWARMY_REPAIRED__ uuid=u-1 moved=0 files=0 bytes=0 aside=-\n`) {
    const scripts: string[] = [];
    const deps: DiskDeps = {
      override: undefined,
      runHost: async (script) => {
        scripts.push(script);
        if (script.includes('mount -t ext4 "$DEV" "$MNT"')) return { code: repairOut.includes('__SWARMY_ERR__') ? 3 : 0, out: repairOut };
        if (script.includes('__SWARMY_PENDING__')) return { code: 0, out: pendingLine };
        return { code: 0, out: back };
      },
      users: async () => users,
    };
    return { deps, scripts, repairs: () => scripts.filter((s) => s.includes('mount -t ext4 "$DEV" "$MNT"')) };
  }

  it('mounts an empty, fstab-declared disk straight away, in the no-copy mode', async () => {
    const h = startHost(`__SWARMY_PENDING__ ${MNT} 0 0\n`, [{ container: 'old-task', service: 'shop_db-primary', running: false }]);
    const logs: string[] = [];
    expect(await mountReturningDisks(h.deps, (m) => logs.push(m))).toEqual(['12345678']);
    expect(h.repairs()).toHaveLength(1);
    expect(h.repairs()[0]).toContain("is not in this server's fstab");
    expect(logs[0]).toContain('mounted it at');
  });

  it('leaves a disk with files, or with a running user, to the controller', async () => {
    const full = startHost(`__SWARMY_PENDING__ ${MNT} 3 100\n`);
    expect(await mountReturningDisks(full.deps, () => undefined)).toEqual([]);
    expect(full.repairs()).toEqual([]);
    const busy = startHost(`__SWARMY_PENDING__ ${MNT} 0 0\n`, [{ container: 'c', running: true }]);
    expect(await mountReturningDisks(busy.deps, () => undefined)).toEqual([]);
    const off = startHost(`__SWARMY_PENDING__ ${MNT} 0 0\n`);
    off.deps.repairAllowed = false;
    expect(await mountReturningDisks(off.deps, () => undefined)).toEqual([]);
    expect(off.scripts).toEqual([]);
  });

  it('never throws; a refusal is logged', async () => {
    const h = startHost(`__SWARMY_PENDING__ ${MNT} 0 0\n`, [], '__SWARMY_ERR__ not in fstab\n');
    const logs: string[] = [];
    expect(await mountReturningDisks(h.deps, (m) => logs.push(m))).toEqual([]);
    expect(logs[0]).toContain('left for the controller');
  });
});
