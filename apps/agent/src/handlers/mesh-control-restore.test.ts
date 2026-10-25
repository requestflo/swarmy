import { describe, expect, test } from 'bun:test';
import { chooseRestoreSource } from '@swarmy/mesh';
import { MESH_CONTROL_VOLUME } from './mesh-control';
import { DATA_DIR, PROBE_SCRIPT, RESTORE_SCRIPT, keptAsName, parseProbe } from './mesh-control-restore-probe';

/** What the probe printed on a node that hosted the control plane before (Litestream's own log lines interleaved). */
const MOVED_BACK = [
  '@@file 4096 1792882493 /var/lib/netbird/store.db',
  '@@file 45352 1792882501 /var/lib/netbird/store.db-wal',
  '@@ltx 567 1792882496 /var/lib/netbird/.store.db-litestream/ltx/0/0000000000000001-0000000000000001.ltx',
  '@@ltx 228 1792882502 /var/lib/netbird/.store.db-litestream/ltx/0/0000000000000005-0000000000000005.ltx',
  'time=2026-10-24T22:55:43.514Z level=INFO msg="some log line"',
  '@@replica [  {    "level": 0,    "min_txid": "0000000000000001",    "max_txid": "0000000000000001",    "size": 567,    "timestamp": "2026-10-24T22:54:56Z"  },' +
    '  {    "level": 0,    "min_txid": "000000000000000c",    "max_txid": "000000000000000c",    "size": 286,    "timestamp": "2026-10-24T22:55:51Z"  }]',
].join('\r\n');

describe('mesh control-plane restore: the probe report', () => {
  test('reads both copies: local size, mtime and LTX files; the backup listing', () => {
    const f = parseProbe(MOVED_BACK);
    expect(f.local.hasData).toBe(true);
    expect(f.local.modifiedAt).toBe(1792882501_000);
    expect(f.local.ltx.map((x) => [x.level, x.maxTxid, x.size, x.at])).toEqual([
      [0, 1n, 567, 1792882496_000],
      [0, 5n, 228, 1792882502_000],
    ]);
    expect(f.replica.reachable).toBe(true);
    expect(f.replica.ltx.map((x) => [x.maxTxid, x.at])).toEqual([
      [1n, Date.parse('2026-10-24T22:54:56Z')],
      [12n, Date.parse('2026-10-24T22:55:51Z')],
    ]);
    // …and the move back restores: the backup is at 12, this node's old copy at 5.
    expect(chooseRestoreSource(f).use).toBe('replica');
  });

  test('an empty volume, an empty backup, and a backup that never answered', () => {
    expect(parseProbe('@@replica []')).toEqual({ local: { hasData: false, modifiedAt: null, ltx: [] }, replica: { reachable: true, ltx: [] } });
    expect(parseProbe('@@file 0 1792882493 /var/lib/netbird/store.db\n@@replica null').local.hasData).toBe(false);
    expect(parseProbe('@@replica-error 124 ').replica).toEqual({ reachable: false, error: 'the backup did not answer within 60 s', ltx: [] });
    expect(parseProbe('@@replica-error 1 Error: access denied ').replica.error).toBe('litestream ltx exited 1: Error: access denied');
    expect(parseProbe('').replica).toEqual({ reachable: false, error: 'the probe said nothing about the backup', ltx: [] });
    expect(parseProbe('@@replica [{"level":').replica.error).toBe('the backup listing was unreadable');
  });
});

describe('mesh control-plane restore: the scripts', () => {
  test('the probe lists the backup with a time limit and never fails on its own', () => {
    expect(PROBE_SCRIPT).toContain('timeout 60 litestream ltx -json -level all -config /tmp/swarmy-litestream.yml "$f"');
    expect(PROBE_SCRIPT.startsWith('set -u\n')).toBe(true);
    expect(PROBE_SCRIPT.endsWith('exit 0')).toBe(true);
    expect(DATA_DIR).toBe('/var/lib/netbird');
  });

  test('the restore replaces nothing until every DB restored, and moves the old files aside, never deleting them', () => {
    const restoreAt = RESTORE_SCRIPT.indexOf('litestream restore');
    const moveAt = RESTORE_SCRIPT.indexOf('mv "$p" "$aside/"');
    expect(restoreAt).toBeGreaterThan(-1);
    expect(moveAt).toBeGreaterThan(restoreAt);
    expect(RESTORE_SCRIPT.startsWith('set -eu\n')).toBe(true);
    // The only rm is a leftover .restoring file from an earlier failed run.
    expect(RESTORE_SCRIPT.match(/rm -[a-z]+ [^\n]+/g)).toEqual(['rm -f "$f.restoring"']);
    expect(RESTORE_SCRIPT).toContain('for p in "$f" "$f-wal" "$f-shm" "$D/.$db.db-litestream"; do');
  });

  test('the kept copy is named by time and sits in the control-plane volume', () => {
    expect(keptAsName(new Date('2026-10-24T12:10:00.123Z'))).toBe('swarmy-stale-2026-10-24T12-10-00Z');
    expect(MESH_CONTROL_VOLUME).toBe('swarmy-mesh-control');
  });
});
