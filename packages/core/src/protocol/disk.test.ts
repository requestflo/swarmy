import { describe, expect, it } from 'bun:test';
import { FormatDiskPayload } from './disk';
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

  it('has timeouts for all three', () => {
    expect(DEFAULT_COMMAND_TIMEOUTS.listDisks).toBeGreaterThan(0);
    expect(DEFAULT_COMMAND_TIMEOUTS.formatDisk).toBeGreaterThanOrEqual(600_000);
    expect(DEFAULT_COMMAND_TIMEOUTS.growDisk).toBeGreaterThanOrEqual(600_000);
  });
});
