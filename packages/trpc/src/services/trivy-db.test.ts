import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TRIVY_CACHE_DIR,
  TRIVY_DB_STALE_MARKER,
  renderTrivyScanScript,
  scanUsedStaleDb,
  trivyDbRepoArgs,
  trivyScanRunOnce,
} from './trivy-db';
import { pickTrivyRefreshNodes } from './trivy-db.service';

describe('trivyDbRepoArgs', () => {
  test('blank → trivy default; a list → one --db-repository flag; junk is dropped', () => {
    expect(trivyDbRepoArgs('')).toEqual([]);
    expect(trivyDbRepoArgs(undefined)).toEqual([]);
    expect(trivyDbRepoArgs('mirror.local/trivy-db:2, ghcr.io/aquasecurity/trivy-db:2')).toEqual([
      '--db-repository',
      'mirror.local/trivy-db:2,ghcr.io/aquasecurity/trivy-db:2',
    ]);
    expect(trivyDbRepoArgs('$(reboot)')).toEqual([]);
  });
});

describe('trivyScanRunOnce', () => {
  test('mounts the shared cache and passes the ref as env, never in the script', () => {
    const r = trivyScanRunOnce("localhost:5000/app@sha256:x';rm -rf /", ['--format', 'json'], { TRIVY_USERNAME: 'u' }, []);
    expect(r.binds).toEqual([`swarmy-trivy-cache:${TRIVY_CACHE_DIR}`]);
    expect(r.entrypoint).toEqual(['/bin/sh', '-c']);
    expect(r.env).toEqual({ TRIVY_USERNAME: 'u', SWARMY_SCAN_REF: "localhost:5000/app@sha256:x';rm -rf /" });
    expect(r.cmd[0]).not.toContain('rm -rf');
    expect(r.cmd[0]).toContain('"$SWARMY_SCAN_REF"');
  });
});

/**
 * Run the scan script under sh with a FAKE `trivy` on PATH that logs its argv,
 * and optionally fails `--download-db-only`. Proves the three branches.
 */
function runScript(opts: { dbAgeSeconds: number | null; downloadFails: boolean }): { log: string; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-trivy-'));
  const cache = path.join(dir, 'cache');
  mkdirSync(path.join(cache, 'db'), { recursive: true });
  if (opts.dbAgeSeconds !== null) {
    const m = path.join(cache, 'db', 'metadata.json');
    writeFileSync(m, '{}');
    const t = Date.now() / 1000 - opts.dbAgeSeconds;
    utimesSync(m, t, t);
  }
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'log');
  writeFileSync(
    path.join(bin, 'trivy'),
    `#!/bin/sh\necho "$*" >> ${log}\ncase "$*" in *--download-db-only*) ${opts.downloadFails ? 'exit 1' : 'exit 0'};; esac\nexit 0\n`,
  );
  chmodSync(path.join(bin, 'trivy'), 0o755);
  const script = renderTrivyScanScript(['--format', 'json'], []).replace(`C='${TRIVY_CACHE_DIR}'`, `C='${cache}'`);
  // GNU `stat -c` exists in the alpine trivy image; macOS dev boxes need a shim.
  const statShim =
    process.platform === 'darwin' ? `stat() { /usr/bin/stat -f %m "$3"; }\n` : '';
  const r = Bun.spawnSync(['sh', '-c', statShim + script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SWARMY_SCAN_REF: 'img:1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let text = '';
  try {
    text = require('node:fs').readFileSync(log, 'utf8');
  } catch {}
  return { log: text, stderr: r.stderr.toString() };
}

describe('scan script', () => {
  test('fresh DB → no update attempted, scan skips the DB update', () => {
    const r = runScript({ dbAgeSeconds: 60, downloadFails: false });
    expect(r.log).not.toContain('--download-db-only');
    expect(r.log).toContain('--skip-db-update');
    expect(r.log.trim().endsWith('img:1')).toBe(true);
  });
  test('old DB + refresh works → one update, then scan with skip', () => {
    const r = runScript({ dbAgeSeconds: 3 * 86400, downloadFails: false });
    expect(r.log).toContain('--download-db-only');
    expect(r.log).toContain('--skip-db-update');
    expect(scanUsedStaleDb(r.stderr)).toBe(false);
  });
  test('old DB + refresh fails → scan the stale DB and flag it (never fail the scan for staleness)', () => {
    const r = runScript({ dbAgeSeconds: 3 * 86400, downloadFails: true });
    expect(r.stderr).toContain(TRIVY_DB_STALE_MARKER);
    expect(r.log.split('\n').filter(Boolean).pop()).toContain('--skip-db-update');
  });
  test('no DB at all → trivy downloads it itself (no skip flag)', () => {
    const r = runScript({ dbAgeSeconds: null, downloadFails: false });
    expect(r.log).not.toContain('--skip-db-update');
  });
});

describe('pickTrivyRefreshNodes', () => {
  test('every online builder; else the first online node; else none', () => {
    const b = { 'swarmy.node.builder': 'true' };
    expect(
      pickTrivyRefreshNodes([
        { id: 'a', labels: b, online: true },
        { id: 'b', labels: {}, online: true },
        { id: 'c', labels: b, online: false },
      ]),
    ).toEqual(['a']);
    expect(pickTrivyRefreshNodes([{ id: 'b', labels: {}, online: true }])).toEqual(['b']);
    expect(pickTrivyRefreshNodes([{ id: 'b', labels: {}, online: false }])).toEqual([]);
  });
});
