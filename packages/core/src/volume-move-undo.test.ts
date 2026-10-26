import { describe, expect, it } from 'bun:test';
import { oldCopy, type VolumeManifest } from './volume-move';
import { copiesAfterUndo, decideUndo, lastMove, MOVE_UNDO_WINDOW_HOURS, type UndoInput } from './volume-move-undo';

const T0 = 1_800_000_000_000;
const SNAP: VolumeManifest = { files: 3, links: 0, dirs: 2, bytes: 1024, digest: 'aaa' };
const WROTE: VolumeManifest = { ...SNAP, bytes: 2048, digest: 'bbb' };
const moved = [oldCopy('n1', 'blog_content', T0, { moveId: 'm1', to: 'n2', manifest: SNAP })];
const names = { service: 'ghost', source: 'wkr-1', dest: 'wkr-2' };
const base: UndoInput = { move: lastMove(moved), now: T0 + 60_000, runningOn: ['n2'], moving: false, sourceReady: true, names };
const vols = (m: VolumeManifest | null) => new Map([['blog_content', m]]);

describe('lastMove', () => {
  it("groups the newest move's volumes and keeps older moves out", () => {
    const older = oldCopy('n0', 'blog_content', T0 - 86_400_000, { moveId: 'm0', to: 'n1', manifest: SNAP });
    const two = [older, ...moved, oldCopy('n1', 'blog_images', T0, { moveId: 'm1', to: 'n2', manifest: SNAP })];
    const m = lastMove(two)!;
    expect(m.source).toBe('n1');
    expect(m.dest).toBe('n2');
    expect(m.copies.map((c) => c.volume)).toEqual(['blog_content', 'blog_images']);
    expect(Date.parse(m.until) - T0).toBe(MOVE_UNDO_WINDOW_HOURS * 3_600_000);
  });

  it('is null with no old copies', () => {
    expect(lastMove([])).toBeNull();
  });
});

describe('decideUndo', () => {
  it('reads the old copy, then the moved copy, then goes — only when both match the snapshot point', () => {
    expect(decideUndo(base)).toEqual({ ok: true, next: 'read-source' });
    expect(decideUndo({ ...base, sourceNow: vols(SNAP) })).toEqual({ ok: true, next: 'read-dest' });
    expect(decideUndo({ ...base, sourceNow: vols(SNAP), destNow: vols(SNAP) })).toEqual({ ok: true, next: 'go' });
  });

  it('refuses when the app wrote on the new server since the move', () => {
    expect(decideUndo({ ...base, sourceNow: vols(SNAP), destNow: vols(WROTE) })).toEqual({
      ok: false,
      reason: 'Writes happened on wkr-2 since the move; undoing would lose them.',
    });
  });

  it('refuses when the old copy changed (or could not be read) on the old server', () => {
    for (const m of [WROTE, null]) {
      const d = decideUndo({ ...base, sourceNow: vols(m), destNow: vols(SNAP) });
      expect(d).toEqual({ ok: false, reason: "The old copy on wkr-1 changed after the move, so swarmy can't prove it's the data ghost left there." });
    }
  });

  it('is off after the window; the copy is then an ordinary old copy', () => {
    const d = decideUndo({ ...base, now: T0 + MOVE_UNDO_WINDOW_HOURS * 3_600_000 + 1 });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toBe('ghost moved more than 24 hours ago, so Undo is off. Its old copy stays on wkr-1 until you delete it.');
  });

  it('refuses a move with no recorded snapshot point (kept before Undo, or the checksum was skipped)', () => {
    const legacy = lastMove([oldCopy('n1', 'blog_content', T0)]);
    const skipped = lastMove([oldCopy('n1', 'blog_content', T0, { to: 'n2', manifest: { ...SNAP, digest: 'skipped' } })]);
    for (const move of [legacy, skipped]) expect(decideUndo({ ...base, move }).ok).toBe(false);
  });

  it('refuses while moving, with nothing kept, off the new server, or with the old server not ready', () => {
    const cases: [Partial<UndoInput>, string][] = [
      [{ moving: true }, 'ghost is already moving.'],
      [{ move: null }, 'There is no move of ghost to undo: swarmy keeps no old copy of it.'],
      [{ runningOn: ['n1'] }, 'ghost already runs on wkr-1.'],
      [{ runningOn: [] }, "ghost isn't running on wkr-2 right now, so swarmy can't tell where its newest data is."],
      [{ runningOn: ['n3'] }, "ghost isn't running on wkr-2 right now, so swarmy can't tell where its newest data is."],
      [{ sourceReady: false }, "wkr-1 isn't ready for work, so ghost can't go back there now."],
    ];
    for (const [patch, reason] of cases) expect(decideUndo({ ...base, ...patch })).toEqual({ ok: false, reason });
  });
});

describe('copiesAfterUndo', () => {
  it('drops the undone copies and keeps the copy left on the new server', () => {
    const other = oldCopy('n9', 'blog_old', T0 - 1);
    const left = [oldCopy('n2', 'blog_content', T0 + 1, { moveId: 'u1', to: 'n1', manifest: SNAP })];
    const after = copiesAfterUndo([other, ...moved], lastMove([other, ...moved])!, left);
    expect(after.map((c) => `${c.nodeId}/${c.volume}`)).toEqual(['n9/blog_old', 'n2/blog_content']);
  });
});
