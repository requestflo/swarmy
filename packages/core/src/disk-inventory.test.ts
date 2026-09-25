import { describe, expect, it } from 'bun:test';
import {
  classifyDisks,
  defaultDiskMount,
  diskEntries,
  diskFormatGateAllows,
  diskId,
  diskLabelsAfterFormat,
  diskMountpoint,
  diskVolumeOptions,
  formatGate,
  growableBytes,
  isDiskFormatCapable,
  nodeDisks,
  parseDiskProbe,
  parseDiskVolumeDevice,
  parseLsblk,
  renderDiskProbeScript,
  renderFormatScript,
  renderGrowScript,
  renderVolumeDirScript,
  shQuote,
  type LsblkDevice,
} from './disk-inventory';

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
    expect(classifyDisks([blank({ fstype: 'ext4', mountpoints: ['/var/lib/swarmy/disks/abcd'] })])[0]!.state).toBe('swarmy');
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
  const swarmyDisk = classifyDisks([blank({ size: 200 * GB, fstype: 'ext4', mountpoints: ['/var/lib/swarmy/disks/u'] })])[0]!;
  it('offers growth when the device outgrew its filesystem', () => {
    expect(growableBytes(swarmyDisk, 100 * GB)).toBe(100 * GB);
  });
  it('ignores filesystem overhead and non-swarmy disks', () => {
    expect(growableBytes(swarmyDisk, 198.5 * GB)).toBe(0);
    expect(growableBytes(classifyDisks([blank()])[0]!, 10 * GB)).toBe(0);
  });
});

describe('format gate: default on, per-node opt-out', () => {
  it('controller: label off or local deny refuses; local allow wins; absent label allows', () => {
    expect(isDiskFormatCapable({}, undefined)).toBe(true);
    expect(isDiskFormatCapable({ 'swarmy.node.diskFormat': 'false' }, undefined)).toBe(false);
    expect(isDiskFormatCapable({ 'swarmy.node.diskFormat': 'false' }, 'allow')).toBe(true);
    expect(isDiskFormatCapable({}, 'deny')).toBe(false);
  });
  it('agent: fails closed without an explicit controller assertion', () => {
    expect(diskFormatGateAllows(undefined, true)).toBe(true);
    expect(diskFormatGateAllows(undefined, undefined)).toBe(false);
    expect(diskFormatGateAllows(undefined, false)).toBe(false);
    expect(diskFormatGateAllows('deny', true)).toBe(false);
    expect(diskFormatGateAllows('allow', false)).toBe(true);
  });
});

describe('disk ids, labels and placement', () => {
  it('sanitises serials into a path/label-safe id', () => {
    expect(diskId('12345678')).toBe('12345678');
    expect(diskId(' HC Volume 1/2 ')).toBe('HC_Volume_1_2');
    expect(diskId('..evil')).toBe('evil');
    expect(diskId('default')).toBe('disk-default');
    expect(() => diskId('...')).toThrow();
    expect(diskMountpoint('12345678')).toBe('/var/lib/swarmy/disks/12345678');
  });

  it('the first formatted disk becomes the default; later ones do not steal it', () => {
    expect(diskLabelsAfterFormat('AAAA1111', {})).toEqual({
      'swarmy.disk.AAAA1111': '/var/lib/swarmy/disks/AAAA1111',
      'swarmy.disk.default': 'AAAA1111',
    });
    const labels = { 'swarmy.disk.AAAA1111': '/var/lib/swarmy/disks/AAAA1111', 'swarmy.disk.default': 'AAAA1111' };
    expect(diskLabelsAfterFormat('BBBB2222', labels)).toEqual({ 'swarmy.disk.BBBB2222': '/var/lib/swarmy/disks/BBBB2222' });
    expect(nodeDisks(labels)).toEqual([{ id: 'AAAA1111', mountpoint: '/var/lib/swarmy/disks/AAAA1111', isDefault: true }]);
  });

  it('ignores a label that points anywhere but its own mountpoint', () => {
    const labels = { 'swarmy.disk.x': '/', 'swarmy.disk.default': 'x' };
    expect(nodeDisks(labels)).toEqual([]);
    expect(defaultDiskMount(labels)).toBeNull();
    expect(diskVolumeOptions(labels, 'shop_db-primary-data')).toBeNull();
  });

  it('new volumes bind into <mount>/volumes/<name>; the device parses back; traversal is refused', () => {
    const labels = { 'swarmy.disk.AAAA1111': '/var/lib/swarmy/disks/AAAA1111', 'swarmy.disk.default': 'AAAA1111' };
    const o = diskVolumeOptions(labels, 'shop_db-primary-data')!;
    expect(o).toEqual({ type: 'none', o: 'bind', device: '/var/lib/swarmy/disks/AAAA1111/volumes/shop_db-primary-data' });
    expect(parseDiskVolumeDevice(o.device)).toEqual({ id: 'AAAA1111', mountpoint: '/var/lib/swarmy/disks/AAAA1111', volume: 'shop_db-primary-data' });
    expect(diskVolumeOptions(labels, '../etc')).toBeNull();
    expect(parseDiskVolumeDevice('/var/lib/swarmy/disks/AAAA1111/volumes/..')).toBeNull();
    expect(parseDiskVolumeDevice('/var/lib/swarmy/disks/AAAA1111/volumes/a/../../x')).toBeNull();
    expect(parseDiskVolumeDevice('/etc/volumes/x')).toBeNull();
  });
});

describe('host scripts', () => {
  it('shQuote survives embedded quotes', () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('probe output parses back into devices, fs sizes and signatures', () => {
    const out = [
      '__SWARMY_LSBLK__',
      JSON.stringify({ blockdevices: [blank({ size: 200 * GB, fstype: 'ext4', mountpoints: ['/var/lib/swarmy/disks/12345678'] })] }),
      '__SWARMY_DF__',
      `/var/lib/swarmy/disks/12345678 ${100 * GB}`,
      '__SWARMY_WIPEFS__',
      '',
      '__SWARMY_BLKID__',
      '__SWARMY_BLKID_RC__ 2',
      '',
    ].join('\n');
    const probe = parseDiskProbe(out);
    expect(probe.signatures).toBe('');
    const [e] = diskEntries(probe);
    expect(e!.state).toBe('swarmy');
    expect(e!.id).toBe('12345678');
    expect(e!.fsTotalBytes).toBe(100 * GB);
    expect(e!.growableBytes).toBe(100 * GB);
  });

  it('a blkid hit or an unknown blkid status counts as a signature (fail closed)', () => {
    const base = '__SWARMY_LSBLK__\n{}\n__SWARMY_DF__\n__SWARMY_WIPEFS__\n\n__SWARMY_BLKID__\n';
    expect(parseDiskProbe(`${base}/dev/sdb: TYPE="xfs"\n__SWARMY_BLKID_RC__ 0\n`).signatures).toContain('xfs');
    expect(parseDiskProbe(`${base}__SWARMY_BLKID_RC__ 4\n`).signatures).toContain('exited 4');
    expect(parseDiskProbe('__SWARMY_ERR__ lsblk is not installed\n').error).toContain('lsblk');
  });

  it('probe and format scripts refuse odd device paths', () => {
    expect(() => renderDiskProbeScript('/dev/sdb; rm -rf /')).toThrow();
    expect(() => renderDiskProbeScript('/dev/../etc/passwd')).toThrow();
    expect(() => renderFormatScript({ path: '/dev/sdb`x`', serial: '1234', sizeBytes: GB })).toThrow();
    expect(renderDiskProbeScript('/dev/nvme1n1')).toContain("wipefs -n '/dev/nvme1n1'");
  });

  it('format script re-checks serial, size, mounts, partitions and signatures before an ext4 mkfs, and mounts by UUID with nofail', () => {
    const s = renderFormatScript({ path: '/dev/sdb', serial: "12'345678", sizeBytes: 100 * GB });
    const mkfs = s.indexOf('mkfs.ext4 -q');
    for (const check of ['different disk', 'changed size', 'is mounted', 'has partitions', 'wipefs -n', 'blkid -p']) {
      expect(s.indexOf(check)).toBeGreaterThan(-1);
      expect(s.indexOf(check)).toBeLessThan(mkfs);
    }
    expect(s).toContain("WANT='12'\\''345678'");
    expect(s).toContain("MNT='/var/lib/swarmy/disks/12_345678'");
    expect(s).toContain('</dev/null');
    expect(s).not.toMatch(/mkfs\.ext4[^\n]* -F/);
    expect(s).toContain('nofail,x-systemd.device-timeout=10s');
    expect(s).toContain('UUID=$UUID $MNT ext4');
  });

  it('grow and volume-dir scripts', () => {
    expect(renderGrowScript('12345678')).toContain('resize2fs');
    expect(renderVolumeDirScript('/var/lib/swarmy/disks/A1/volumes/v')).toContain("mountpoint -q '/var/lib/swarmy/disks/A1'");
    expect(() => renderVolumeDirScript('/tmp/x')).toThrow();
  });
});
