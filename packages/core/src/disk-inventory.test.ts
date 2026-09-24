import { describe, expect, it } from 'bun:test';
import { classifyDisks, formatGate, growableBytes, parseLsblk, type LsblkDevice } from './disk-inventory';

const GB = 1024 ** 3;

// Shaped like `lsblk -J -b -o NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINTS,SERIAL,MODEL,RO,RM,PTTYPE`
// on a Hetzner CX22 with one attached volume.
const HETZNER = JSON.stringify({
  blockdevices: [
    {
      name: 'sda', path: '/dev/sda', size: 40 * GB, type: 'disk', fstype: null, mountpoints: [null],
      serial: '0QEMU_QEMU_HARDDISK_drive-scsi0', model: 'QEMU HARDDISK', ro: false, rm: false, pttype: 'gpt',
      children: [
        { name: 'sda1', path: '/dev/sda1', size: 39 * GB, type: 'part', fstype: 'ext4', mountpoints: ['/'] },
        { name: 'sda15', path: '/dev/sda15', size: 256 * 1024 ** 2, type: 'part', fstype: 'vfat', mountpoints: ['/boot/efi'] },
      ],
    },
    { name: 'sdb', path: '/dev/sdb', size: 100 * GB, type: 'disk', fstype: null, mountpoints: [null], serial: '12345678', model: 'Volume', ro: false, rm: false, pttype: null },
    { name: 'sr0', path: '/dev/sr0', size: 1024 ** 2, type: 'rom', fstype: null, mountpoints: [null], ro: false, rm: true },
    { name: 'loop0', path: '/dev/loop0', size: 64 * 1024 ** 2, type: 'loop', fstype: 'squashfs', mountpoints: ['/snap/core/1'] },
  ],
});

const blank = (over: Partial<LsblkDevice> = {}): LsblkDevice => ({
  name: 'sdb', path: '/dev/sdb', size: 100 * GB, type: 'disk', fstype: null, mountpoints: [null], serial: '12345678', ro: false, rm: false, pttype: null,
  ...over,
});

describe('classifyDisks', () => {
  it('root disk is system; the attached empty volume is blank; rom/loop are not listed', () => {
    const disks = classifyDisks(parseLsblk(HETZNER));
    expect(disks.map((d) => [d.name, d.state])).toEqual([
      ['sda', 'system'],
      ['sdb', 'blank'],
    ]);
    expect(disks[1]!.sizeBytes).toBe(100 * GB);
  });

  it('any filesystem, partition table or partition means has-data', () => {
    expect(classifyDisks([blank({ fstype: 'ext4' })])[0]!.state).toBe('has-data');
    expect(classifyDisks([blank({ pttype: 'dos' })])[0]!.state).toBe('has-data');
    expect(classifyDisks([blank({ children: [{ name: 'sdb1', type: 'part', fstype: null }] })])[0]!.state).toBe('has-data');
    expect(classifyDisks([blank({ fstype: 'LVM2_member' })])[0]!.reason).toContain('will not format');
  });

  it('swap, docker root and swarmy mounts', () => {
    expect(classifyDisks([blank({ fstype: 'swap' })])[0]!.state).toBe('system');
    expect(classifyDisks([blank({ fstype: 'xfs', mountpoints: ['/var/lib/docker'] })])[0]!.state).toBe('system');
    expect(classifyDisks([blank({ fstype: 'ext4', mountpoints: ['/mnt/swarmy/abcd'] })])[0]!.state).toBe('swarmy');
    expect(classifyDisks([blank({ fstype: 'ext4', mountpoint: '/data' })])[0]!.state).toBe('mounted');
  });

  it('read-only, removable, tiny → ineligible; string flags from old lsblk', () => {
    expect(classifyDisks([blank({ ro: '1' })])[0]!.state).toBe('ineligible');
    expect(classifyDisks([blank({ rm: 1 })])[0]!.state).toBe('ineligible');
    expect(classifyDisks([blank({ size: '104857600' })])[0]!.state).toBe('ineligible');
  });

  it('bad JSON parses to nothing', () => {
    expect(parseLsblk('not json')).toEqual([]);
    expect(parseLsblk({ nope: 1 })).toEqual([]);
  });
});

describe('formatGate', () => {
  const expected = { path: '/dev/sdb', serial: '12345678', sizeBytes: 100 * GB };
  const ok = { devices: [blank()], expected, wipefsOutput: '', typedConfirmation: '5678' };

  it('passes only for the same blank disk with a matching confirmation', () => {
    expect(formatGate(ok)).toEqual({ ok: true });
  });

  it('refuses a signature, a changed serial or size, a gone disk, a bad confirmation, no serial', () => {
    expect(formatGate({ ...ok, wipefsOutput: 'DEVICE OFFSET TYPE UUID LABEL\nsdb 0x438 ext4 …' }).ok).toBe(false);
    expect(formatGate({ ...ok, devices: [blank({ serial: 'ffff0000' })] }).ok).toBe(false);
    expect(formatGate({ ...ok, devices: [blank({ size: 200 * GB })] }).ok).toBe(false);
    expect(formatGate({ ...ok, devices: [] }).ok).toBe(false);
    expect(formatGate({ ...ok, typedConfirmation: '1234' }).ok).toBe(false);
    expect(formatGate({ ...ok, expected: { ...expected, serial: '' } }).ok).toBe(false);
    const mounted = formatGate({ ...ok, devices: [blank({ fstype: 'ext4', mountpoints: ['/mnt/x'] })] });
    expect(mounted).toEqual({ ok: false, reason: 'Already mounted at /mnt/x.' });
  });
});

describe('growableBytes', () => {
  const swarmyDisk = classifyDisks([blank({ size: 200 * GB, fstype: 'ext4', mountpoints: ['/mnt/swarmy/u'] })])[0]!;
  it('offers growth when the device outgrew its filesystem', () => {
    expect(growableBytes(swarmyDisk, 100 * GB)).toBe(100 * GB);
  });
  it('ignores filesystem overhead and non-swarmy disks', () => {
    expect(growableBytes(swarmyDisk, 198.5 * GB)).toBe(0);
    expect(growableBytes(classifyDisks([blank()])[0]!, 10 * GB)).toBe(0);
  });
});
