import { describe, expect, test } from 'bun:test';
import { changesSince, imageTag, nearestRestorePoint, pitrTarget, releaseAt, replayAt, restoreModes } from './time-travel-replay';
import { ago, H, NOW, RELEASES, SAVES } from './time-travel-fixtures';

describe('replay at T', () => {
  test('the release in effect is the newest at or before T', () => {
    expect(releaseAt(RELEASES, NOW - 2 * H)?.id).toBe('r5');
    expect(releaseAt(RELEASES, NOW - 26 * H - 10 * 60_000)?.id).toBe('r4');
    expect(releaseAt(RELEASES, NOW - 30 * 24 * H)).toBeNull();
  });

  test('each part with its tag then and whether it changed since', () => {
    const { release, parts } = replayAt(RELEASES, NOW - 3 * 24 * H);
    expect(release?.id).toBe('r3');
    expect(parts).toEqual([
      { name: 'web', image: 'ghcr.io/northwind/storefront-web:1.8.2', tag: '1.8.2', nowTag: '1.9.0', changed: true },
      { name: 'api', image: 'ghcr.io/northwind/storefront-api:1.8.1', tag: '1.8.1', nowTag: '1.9.0', changed: true },
      { name: 'worker', image: 'ghcr.io/northwind/storefront-worker:1.8.1', tag: '1.8.1', nowTag: '1.9.0', changed: true },
    ]);
    expect(replayAt(RELEASES, NOW).parts.every((p) => !p.changed)).toBe(true);
    expect(replayAt(RELEASES, NOW).later).toEqual([]);
  });

  test('a part gone since keeps no tag; one added since comes back with the release that brought it', () => {
    const r = replayAt(RELEASES, NOW - 8 * 24 * H);
    expect(r.parts.find((p) => p.name === 'cdn')?.nowTag).toBeNull();
    expect(r.later).toEqual([{ name: 'worker', label: 'v1.8.2', at: NOW - 4 * 24 * H }]);
  });

  test('image tags: tag, digest, none', () => {
    expect(imageTag('ghcr.io/a/b:1.2.3')).toBe('1.2.3');
    expect(imageTag('localhost:5000/b')).toBe('latest');
    expect(imageTag('a/b@sha256:0123456789abcdef0123')).toBe('0123456789ab');
  });
});

describe('changes since T', () => {
  test('releases after T, newest first, with the parts each changed', () => {
    const c = changesSince(RELEASES, NOW - 3 * 24 * H);
    expect(c.map((x) => [x.label, x.parts.join(','), x.putBack])).toEqual([
      ['v1.9.0', 'web,api,worker', false],
      ['v1.8.2', 'web,api,worker', true],
      ['v1.8.3', 'web,api,worker', false],
    ]);
    expect(changesSince(RELEASES, NOW - 8 * 24 * H).at(-1)).toMatchObject({ label: 'v1.8.2', parts: ['web', 'api', 'worker'], removed: ['cdn'] });
  });

  test('nothing at now', () => {
    expect(changesSince(RELEASES, NOW)).toEqual([]);
  });
});

describe('nearest restore point', () => {
  test('the newest save at or before T', () => {
    expect(nearestRestorePoint(SAVES, NOW)).toMatchObject({ backup: { id: 's33' }, before: true });
    expect(nearestRestorePoint(SAVES, NOW - 60 * H)).toMatchObject({ backup: { id: 's81' }, before: true });
  });

  test('the earliest after T when none is older; null with no saves', () => {
    expect(nearestRestorePoint(SAVES, NOW - 100 * H)).toMatchObject({ backup: { id: 's81' }, before: false });
    expect(nearestRestorePoint([], NOW)).toBeNull();
  });

  test('a point-in-time restore lands on T inside the recoverable span, its ends outside it', () => {
    const window = { from: ago(30 * H), to: ago(10 * 60_000) };
    expect(pitrTarget(NOW - 5 * H, window, 0)).toBe(NOW - 5 * H);
    expect(pitrTarget(NOW, window, 0)).toBe(NOW - 10 * 60_000);
    expect(pitrTarget(NOW - 50 * H, window, 0)).toBe(NOW - 30 * H);
    expect(pitrTarget(NOW, null, 123)).toBe(123);
  });

  test('a logical save restores as a copy or in place; a physical one only point-in-time', () => {
    expect(restoreModes('pg_dump')).toEqual({ copy: 'clone-to-new-cluster', replace: 'in-place' });
    expect(restoreModes('wal-g')).toEqual({ copy: null, replace: 'pitr' });
  });
});
