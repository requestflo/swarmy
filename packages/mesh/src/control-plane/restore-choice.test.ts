import { describe, expect, it } from 'bun:test';
import { chooseRestoreSource, headOf, type LtxFile, type RestoreFacts } from './restore-choice';

const T = Date.parse('2026-10-24T12:00:00Z');
const MIN = 60_000;
const ltx = (min: number, max: number, at: number, size = 200, level = 0): LtxFile => ({ level, minTxid: BigInt(min), maxTxid: BigInt(max), size, at });
/** A copy that ran Litestream up to `upTo`, one file per transaction, a second apart from `start`. */
const run = (from: number, upTo: number, start: number, size = 200): LtxFile[] =>
  Array.from({ length: upTo - from + 1 }, (_, i) => ltx(from + i, from + i, start + i * 1000, size + i));
const facts = (local: Partial<RestoreFacts['local']>, replica: Partial<RestoreFacts['replica']> = {}): RestoreFacts => ({
  local: { hasData: true, modifiedAt: T, ltx: [], ...local },
  replica: { reachable: true, ltx: [], ...replica },
});

describe('which copy a mesh control-plane restore runs (the newest state wins)', () => {
  it('moving back to a node that hosted it before restores the backup and keeps the old copy aside', () => {
    // A ran to transaction 5 and moved away; B restored and wrote 6..12 later on.
    const a = run(1, 5, T);
    const replica = [...a, ...run(6, 12, T + 10 * MIN, 600)];
    const c = chooseRestoreSource(facts({ ltx: a, modifiedAt: T + 5000 }, { ltx: replica }));
    expect(c).toEqual({
      use: 'replica',
      moveAside: true,
      reason: "Restored the backup saved 2026-10-24 12:10 UTC: it is further along (transaction 12) than this server's old copy (transaction 5).",
    });
  });

  it("keeps a copy that continues the backup's latest save, with or without unshipped transactions", () => {
    const shipped = run(1, 5, T);
    const ahead = chooseRestoreSource(facts({ ltx: [...shipped, ltx(6, 6, T + 5000, 999)] }, { ltx: shipped }));
    expect(ahead.use).toBe('local');
    expect(ahead.moveAside).toBe(false);
    expect(ahead.reason).toBe("Kept this server's copy: it continues the backup's latest save (transaction 5) and has 1 newer transaction the backup hadn't received.");
    // The replica's time is the bucket's clock: a second or two off still matches.
    const replicaClock = shipped.map((f) => ({ ...f, at: f.at + 2000 }));
    expect(chooseRestoreSource(facts({ ltx: shipped }, { ltx: replicaClock })).reason).toBe("Kept this server's copy: it is the backup's latest save (transaction 5).");
  });

  it('a higher transaction number on another lineage is not newer: another server wrote the backup since', () => {
    // A had 1..10 locally but only 1..8 shipped; B restored at 8 and wrote its own 9.
    const a = run(1, 10, T);
    const replica = [...run(1, 8, T), ltx(9, 9, T + 3 * MIN, 431)];
    const c = chooseRestoreSource(facts({ ltx: a }, { ltx: replica }));
    expect(c.use).toBe('replica');
    expect(c.reason).toContain("this server's old copy reaches transaction 10 but doesn't continue the backup's latest save (transaction 9)");
    // Same number and size, but written minutes apart: a different file.
    const same = [...run(1, 8, T), ltx(9, 9, T + 3 * MIN, a[8]!.size)];
    expect(chooseRestoreSource(facts({ ltx: a }, { ltx: same })).use).toBe('replica');
  });

  it('with no local position, only a write well after the backup keeps the local copy', () => {
    const replica = run(1, 5, T);
    expect(chooseRestoreSource(facts({ modifiedAt: T + 30 * MIN }, { ltx: replica })).reason).toBe(
      "Kept this server's copy: it was last written 2026-10-24 12:30 UTC, well after the backup's newest save (2026-10-24 12:00 UTC).",
    );
    // Within the clock allowance, older, or unknown: the backup wins.
    for (const modifiedAt of [T + 60_000, T - 30 * MIN, null]) {
      expect(chooseRestoreSource(facts({ modifiedAt }, { ltx: replica })).use).toBe('replica');
    }
  });

  it('an empty volume restores; an empty backup keeps the only copy; nothing anywhere starts fresh', () => {
    expect(chooseRestoreSource(facts({ hasData: false, modifiedAt: null }, { ltx: run(1, 3, T) }))).toEqual({
      use: 'replica',
      moveAside: false,
      reason: 'Restored the backup saved 2026-10-24 12:00 UTC: this server had no copy of its own.',
    });
    expect(chooseRestoreSource(facts({})).use).toBe('local');
    expect(chooseRestoreSource(facts({ hasData: false })).use).toBe('fresh');
  });

  it('an unreachable backup refuses, whatever is on the volume', () => {
    const down = { reachable: false, error: 'litestream ltx exited 124' };
    const withCopy = chooseRestoreSource(facts({ ltx: run(1, 5, T) }, down));
    expect(withCopy.use).toBe('refuse');
    expect(withCopy.reason).toBe(
      "Couldn't read the backup (litestream ltx exited 124), so there is no telling whether this server's own copy is current. Nothing was changed; try again once object storage answers.",
    );
    expect(chooseRestoreSource(facts({ hasData: false }, down)).reason).toContain('Starting empty would drop every server and setup key');
  });

  it("the head is the highest transaction, the lowest level's file when compaction holds the same range", () => {
    expect(headOf([ltx(1, 9, T, 900, 1), ltx(9, 9, T, 50, 0), ltx(1, 3, T, 300, 9)])).toEqual(ltx(9, 9, T, 50, 0));
    expect(headOf([])).toBeNull();
  });
});
