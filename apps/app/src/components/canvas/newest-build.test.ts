import { describe, expect, test } from 'bun:test';
import { newestBuild, seconds } from './newest-build';

const services = [
  { id: 's1', name: 'shop_api', image: 'reg/api@sha256:aaa' },
  { id: 's2', name: 'shop_web', image: 'ghcr.io/web:1' },
];
const repos = [
  { id: 'r1', serviceId: 's1' },
  { id: 'r2', serviceId: 'elsewhere' },
];
const t0 = Date.parse('2026-10-23T10:00:00Z');
const at = (s: number): string => new Date(t0 + s * 1000).toISOString();
const build = (o: Partial<Parameters<typeof newestBuild>[3][number]>) => ({ id: 'b', repoId: 'r1', status: 'succeeded', image: 'reg/api@sha256:aaa', commit: 'abcdef123', startedAt: at(0), finishedAt: at(38), ...o });

describe('newestBuild', () => {
  test('build time, the scan of that digest, and the part running it', () => {
    const b = newestBuild('shop', services, repos, [build({})], [{ digest: 'sha256:aaa', status: 'passed', criticalCount: 0, highCount: 0 }]);
    expect(b?.part).toBe('api');
    expect(b?.chips).toEqual([
      { label: 'build ✓ 38 s', tone: 'ok' },
      { label: 'scan clean', tone: 'ok' },
      { label: 'running on api', tone: 'ok' },
    ]);
    expect(b?.tech).toBe('abcdef1 · reg/api@sha256:aaa');
  });

  test('the newest wins; a running build shows only its elapsed time', () => {
    const b = newestBuild('shop', services, repos, [build({}), build({ id: 'n', status: 'building', image: null, startedAt: at(100), finishedAt: null })], [], t0 + 141_000);
    expect(b?.id).toBe('n');
    expect(b?.chips).toEqual([{ label: 'building… 41 s', tone: 'info' }]);
  });

  test('no scan row, no scan chip; builds for other apps are ignored', () => {
    expect(newestBuild('shop', services, repos, [build({ image: 'reg/api@sha256:bbb' })], [])?.chips).toEqual([{ label: 'build ✓ 38 s', tone: 'ok' }]);
    expect(newestBuild('shop', services, repos, [build({ repoId: 'r2' })], [])).toBeNull();
    expect(newestBuild('shop', services, repos, [build({ status: 'failed' })], [])?.chips).toEqual([{ label: 'build failed', tone: 'bad' }]);
  });

  test('seconds', () => {
    expect(seconds(38)).toBe('38 s');
    expect(seconds(185)).toBe('3 min');
  });
});
