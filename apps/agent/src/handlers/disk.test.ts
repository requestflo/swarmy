import { describe, expect, it } from 'bun:test';
import type { FormatDiskPayload } from '@swarmy/core/protocol';
import { ensureDiskVolumeDir, formatDisk, growDisk, listDisks, type DiskDeps } from './disk';
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
