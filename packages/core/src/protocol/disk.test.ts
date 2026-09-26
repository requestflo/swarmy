import { describe, expect, it } from 'bun:test';
import { DiskEntryWire, FormatDiskPayload, RepairDiskPayload } from './disk';
import { DEFAULT_COMMAND_TIMEOUTS } from './constants';
import { parseControllerEnvelope } from './messages';

const CMD_ID = '00000000-0000-4000-8000-000000000031';
const frame = (type: string, payload: unknown) => ({ v: 1, id: CMD_ID, ts: 1, type, payload });

describe('disk commands (add a disk)', () => {
  it('listDisks / formatDisk / growDisk round-trip through the controller envelope', () => {
    expect(parseControllerEnvelope(frame('listDisks', { commandId: CMD_ID })).type).toBe('listDisks');
    const f = parseControllerEnvelope(
      frame('formatDisk', { commandId: CMD_ID, path: '/dev/sdb', serial: '12345678', sizeBytes: 1024 ** 3, typedConfirmation: '5678', nodeCapable: true }),
    );
    expect(f.type).toBe('formatDisk');
    if (f.type === 'formatDisk') expect(f.payload.fstype).toBe('ext4');
    expect(parseControllerEnvelope(frame('growDisk', { commandId: CMD_ID, serial: '12345678' })).type).toBe('growDisk');
  });

  it('refuses odd device paths, other filesystems and short serials', () => {
    const ok = { commandId: CMD_ID, path: '/dev/sdb', serial: '12345678', sizeBytes: 1, typedConfirmation: '5678' };
    expect(FormatDiskPayload.safeParse(ok).success).toBe(true);
    expect(FormatDiskPayload.safeParse({ ...ok, path: '/dev/sdb;reboot' }).success).toBe(false);
    expect(FormatDiskPayload.safeParse({ ...ok, path: '/dev/../etc/shadow' }).success).toBe(false);
    expect(FormatDiskPayload.safeParse({ ...ok, fstype: 'xfs' }).success).toBe(false);
    expect(FormatDiskPayload.safeParse({ ...ok, serial: 'abc' }).success).toBe(false);
  });

  it('repairDisk round-trips, defaults its wait and refuses odd stamps (QA-075b)', () => {
    const r = parseControllerEnvelope(frame('repairDisk', { commandId: CMD_ID, path: '/dev/sdb', serial: '12345678', stamp: '20260926T101500Z', nodeCapable: true }));
    expect(r.type).toBe('repairDisk');
    if (r.type === 'repairDisk') expect(r.payload.waitMs).toBe(120_000);
    const ok = { commandId: CMD_ID, path: '/dev/sdb', serial: '12345678', stamp: 'x' };
    expect(RepairDiskPayload.safeParse({ ...ok, stamp: '$(reboot)' }).success).toBe(false);
    expect(RepairDiskPayload.safeParse({ ...ok, path: '/dev/sdb;x' }).success).toBe(false);
    expect(DEFAULT_COMMAND_TIMEOUTS.repairDisk).toBeGreaterThanOrEqual(3_600_000);
    const entry = {
      name: 'sdb', path: '/dev/sdb', sizeBytes: 1, serial: 's', model: null, state: 'swarmy-unmounted', mountpoints: [], fstype: 'ext4',
      reason: 'r', id: 's', fsTotalBytes: null, growableBytes: 0, pending: { files: 2, bytes: 10, services: ['shop_db-primary'] },
    };
    expect(DiskEntryWire.parse(entry).pending?.services).toEqual(['shop_db-primary']);
  });

  it('has timeouts for all three', () => {
    expect(DEFAULT_COMMAND_TIMEOUTS.listDisks).toBeGreaterThan(0);
    expect(DEFAULT_COMMAND_TIMEOUTS.formatDisk).toBeGreaterThanOrEqual(600_000);
    expect(DEFAULT_COMMAND_TIMEOUTS.growDisk).toBeGreaterThanOrEqual(600_000);
  });
});
