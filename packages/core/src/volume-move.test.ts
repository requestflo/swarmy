import { describe, expect, it } from 'bun:test';
import {
  addOldCopies,
  compareManifests,
  manifestScript,
  moverServiceName,
  newMoveId,
  oldCopiesDue,
  oldCopy,
  parseManifest,
  parseMoveState,
  parseOldCopies,
  parseRsyncStats,
  pullScript,
  repinSpec,
  serveScript,
  switchoverRequested,
} from './volume-move';

const NOW = 1_800_000_000_000;

describe('scripts', () => {
  it('serve: one read-only module per volume, password from the secret into /dev/shm, bounded lifetime', () => {
    const s = serveScript(['shop_uploads', 'shop_db-primary-data']);
    expect(s).toContain('[shop_uploads]\\n  path = /src/shop_uploads\\n  read only = yes');
    expect(s).toContain('/run/secrets/swarmy-move-secret');
    expect(s).toContain('/dev/shm/rsyncd.secrets');
    expect(s).toContain('exec timeout 43200 rsync --daemon --no-detach --port=8730');
    expect(s).not.toContain('/var/lib');
  });

  it('refuses names that could break out of the script', () => {
    expect(() => serveScript(['a;rm -rf /'])).toThrow();
    expect(() => pullScript({ host: 'x', volume: '$(id)', final: true, requireEmpty: false })).toThrow();
    expect(() => pullScript({ host: 'a b', volume: 'v', final: true, requireEmpty: false })).toThrow();
  });

  it('pull: live pass tolerates vanished files, final does not; first pass refuses a non-empty destination', () => {
    const live = pullScript({ host: 'swarmy-move-abc', volume: 'v1', final: false, requireEmpty: true, bwlimitKbps: 5000 });
    expect(live).toContain('rsync://swarmy@swarmy-move-abc:8730/v1/');
    expect(live).toContain('--delete');
    expect(live).toContain('--bwlimit=5000');
    expect(live).toContain('[ $rc -eq 24 ] && rc=0');
    expect(live).toContain('SWARMY_DEST_NOT_EMPTY');
    const final = pullScript({ host: 'swarmy-move-abc', volume: 'v1', final: true, requireEmpty: false });
    expect(final).not.toContain('rc -eq 24');
    expect(final).not.toContain('SWARMY_DEST_NOT_EMPTY');
  });

  it('manifest prints the five keys', () => {
    const m = manifestScript();
    for (const k of ['FILES=', 'LINKS=', 'DIRS=', 'BYTES=', 'DIGEST=']) expect(m).toContain(k);
    expect(manifestScript(false)).toContain('DIGEST=skipped');
  });

  it('names and ids are DNS-safe', () => {
    const id = newMoveId(NOW, () => 0.5);
    expect(id).toMatch(/^[a-z0-9]+$/);
    expect(moverServiceName(id)).toBe(`swarmy-move-${id}`);
  });
});

describe('parsers', () => {
  it('manifest round-trip and compare', () => {
    const out = 'FILES=12\nLINKS=1\nDIRS=4\nBYTES=4096\nDIGEST=abc123\n';
    const a = parseManifest(out)!;
    expect(a).toEqual({ files: 12, links: 1, dirs: 4, bytes: 4096, digest: 'abc123' });
    expect(compareManifests(a, { ...a })).toBeNull();
    expect(compareManifests(a, { ...a, files: 11 })).toContain('file count');
    expect(compareManifests(a, { ...a, digest: 'x' })).toContain('checksums');
    expect(parseManifest('FILES=1\n')).toBeNull();
  });

  it('rsync stats', () => {
    const out = `Number of files: 1,204 (reg: 1,100, dir: 104)
Total file size: 2,147,483,648 bytes
Total transferred file size: 1,048,576 bytes
SWARMY_RSYNC_EXIT=0`;
    expect(parseRsyncStats(out)).toEqual({
      exit: 0,
      files: 1204,
      totalBytes: 2147483648,
      transferredBytes: 1048576,
      destNotEmpty: false,
    });
    expect(parseRsyncStats('SWARMY_DEST_NOT_EMPTY').destNotEmpty).toBe(true);
    expect(parseRsyncStats('boom').exit).toBeNull();
  });
});

describe('repinSpec', () => {
  it('replaces node pins, keeps region constraints, re-points pin labels only where present', () => {
    const spec = {
      name: 'x',
      labels: { 'swarmy.search.node': 'old', other: '1' },
      placement: { constraints: ['node.id==old', 'node.hostname==fra-1', 'node.labels.swarmy.region==eu'], maxReplicasPerNode: 1 },
    };
    const out = repinSpec(spec, 'new', ['swarmy.search.node', 'swarmy.cache.node']);
    expect(out.placement.constraints).toEqual(['node.labels.swarmy.region==eu', 'node.id==new']);
    expect(out.placement.maxReplicasPerNode).toBe(1);
    expect(out.labels).toEqual({ 'swarmy.search.node': 'new', other: '1' });
    expect(spec.placement.constraints).toHaveLength(3); // not mutated
  });
});

describe('labels', () => {
  it('old copies: add, dedupe, prompt after 7 days', () => {
    const raw = addOldCopies(undefined, [oldCopy('n1', 'v1', NOW)]);
    const raw2 = addOldCopies(raw, [oldCopy('n1', 'v1', NOW + 1000), oldCopy('n2', 'v2', NOW)]);
    expect(parseOldCopies(raw2)).toHaveLength(2);
    expect(oldCopiesDue(raw2, NOW + 6 * 86_400_000)).toEqual([]);
    expect(oldCopiesDue(raw2, NOW + 7 * 86_400_000 + 1000).map((c) => c.volume).sort()).toEqual(['v1', 'v2']);
    expect(parseOldCopies('not json')).toEqual([]);
  });

  it('move state parses defensively', () => {
    expect(parseMoveState('{"id":"a","step":"stop"}')?.step).toBe('stop');
    expect(parseMoveState('{}')).toBeNull();
    expect(parseMoveState(undefined)).toBeNull();
  });

  it('switchover request is honoured only while fresh', () => {
    const at = new Date(NOW).toISOString();
    expect(switchoverRequested({ 'swarmy.db.switchover': at }, NOW + 60_000)).toBe(true);
    expect(switchoverRequested({ 'swarmy.db.switchover': at }, NOW + 11 * 60_000)).toBe(false);
    expect(switchoverRequested({ 'swarmy.db.switchover': at }, NOW - 1)).toBe(false);
    expect(switchoverRequested({}, NOW)).toBe(false);
  });
});
