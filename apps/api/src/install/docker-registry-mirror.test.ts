import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_REGISTRY_MIRROR_FALLBACK_URL, DEFAULT_REGISTRY_MIRROR_URL, DOCKER_REGISTRY_MIRROR_SH } from './docker-registry-mirror';
import { renderInstaller } from './installer';

const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

/** Run `merge_registry_mirror` from the snippet under `sh -eu` (the join script's shell). */
const MIRRORS = [DEFAULT_REGISTRY_MIRROR_URL, DEFAULT_REGISTRY_MIRROR_FALLBACK_URL];

function merge(content: string | null, env: Record<string, string> = {}): { out: string; code: number } {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-regmirror-'));
  const file = path.join(dir, 'daemon.json');
  if (content !== null) writeFileSync(file, content);
  const lib = path.join(dir, 'lib.sh');
  writeFileSync(lib, DOCKER_REGISTRY_MIRROR_SH);
  const r = Bun.spawnSync(
    ['sh', '-euc', `ok(){ :; }; warn(){ :; }; . "$0"; rc=0; merge_registry_mirror "$1" || rc=$?; echo "rc=$rc"`, lib, file],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } },
  );
  const text = r.stdout.toString();
  const m = /rc=(\d+)\n$/.exec(text);
  return { out: text.replace(/rc=\d+\n$/, ''), code: m ? Number(m[1]) : -1 };
}

describe('daemon.json registry-mirrors merge (installer + join script)', () => {
  it('writes the mirror when daemon.json is missing or empty', () => {
    for (const c of [null, '', '  \n']) {
      const r = merge(c);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ 'registry-mirrors': MIRRORS });
    }
  }, 30_000);

  it('merges into existing settings (e.g. the log-opts the step before wrote)', () => {
    const r = merge('{"log-driver": "json-file", "log-opts": {"max-size": "10m"}, "live-restore": true}');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      'log-driver': 'json-file',
      'log-opts': { 'max-size': '10m' },
      'live-restore': true,
      'registry-mirrors': MIRRORS,
    });
  }, 30_000);

  it('lists mirror.gcr.io after the cache, so a failing cache falls back before Hub', () => {
    expect(MIRRORS).toEqual(['http://localhost:5001', 'https://mirror.gcr.io']);
  });

  it("upgrades swarmy's older cache-only list; a current list is left alone", () => {
    const r = merge(`{"live-restore": true, "registry-mirrors": ["${DEFAULT_REGISTRY_MIRROR_URL}"]}`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ 'live-restore': true, 'registry-mirrors': MIRRORS });
    expect(merge(JSON.stringify({ 'registry-mirrors': MIRRORS })).code).toBe(3);
  }, 30_000);

  it('SWARMY_REGISTRY_MIRROR_FALLBACK=off keeps the cache alone', () => {
    const r = merge(null, { SWARMY_REGISTRY_MIRROR_FALLBACK: 'off' });
    expect(JSON.parse(r.out)).toEqual({ 'registry-mirrors': [DEFAULT_REGISTRY_MIRROR_URL] });
    expect(merge(`{"registry-mirrors": ["${DEFAULT_REGISTRY_MIRROR_URL}"]}`, { SWARMY_REGISTRY_MIRROR_FALLBACK: '' }).code).toBe(3);
  }, 30_000);

  it("never touches an operator's own mirrors", () => {
    expect(merge('{"registry-mirrors": ["https://mirror.example"]}').code).toBe(3);
    expect(merge('{"registry-mirrors": []}').code).toBe(3);
  }, 30_000);

  it('refuses to merge JSON it cannot parse as an object', () => {
    expect(merge('[1,2]').code).toBe(2);
    expect(merge('{not json').code).toBe(2);
  }, 30_000);

  it('an explicitly empty SWARMY_REGISTRY_MIRROR skips the step', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-regmirror-'));
    const lib = path.join(dir, 'lib.sh');
    const file = path.join(dir, 'daemon.json');
    writeFileSync(lib, DOCKER_REGISTRY_MIRROR_SH);
    const r = Bun.spawnSync(['sh', '-euc', `ok(){ :; }; warn(){ :; }; . "$0"; ensure_docker_registry_mirror; [ ! -e "$1" ] && echo skipped`, lib, file], {
      env: { ...process.env, SWARMY_REGISTRY_MIRROR: '', SWARMY_DAEMON_JSON: file },
      stdout: 'pipe',
    });
    expect(r.stdout.toString()).toContain('skipped');
  }, 30_000);
});

describe('registry mirror is wired into both installers', () => {
  it('install-swarmy.sh carries the SAME snippet (no drift) and runs it after the log-opts step', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain(DOCKER_REGISTRY_MIRROR_SH);
    expect(script).toMatch(/\n\s+(with_public_umask )?ensure_docker_log_opts[^\n]*\n\s+(with_public_umask )?ensure_docker_registry_mirror/);
  });

  it('the worker join script merges the mirror', () => {
    const s = renderInstaller({
      controllerUrl: 'https://swarmy.example',
      version: '1.0.0',
      agentImage: 'ghcr.io/x/agent:1',
      binaryBaseUrl: 'https://cdn.example',
      binarySha256: { 'linux-x64': 'a'.repeat(64) },
    });
    expect(s).toContain(`${DOCKER_REGISTRY_MIRROR_SH}ensure_docker_registry_mirror\n`);
    expect(Bun.spawnSync(['sh', '-n', '-c', s]).exitCode).toBe(0);
  }, 30_000);
});
