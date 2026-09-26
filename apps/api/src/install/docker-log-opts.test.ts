import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DOCKER_LOG_OPTS_SH, DOCKER_RUN_LOG_FLAGS } from './docker-log-opts';
import { renderInstaller } from './installer';

const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

/** Run `merge_log_opts` from the snippet under `sh -eu` (the join script's shell). */
function merge(content: string | null): { out: string; code: number } {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-logopts-'));
  const file = path.join(dir, 'daemon.json');
  if (content !== null) writeFileSync(file, content);
  const lib = path.join(dir, 'lib.sh');
  writeFileSync(lib, DOCKER_LOG_OPTS_SH);
  const r = Bun.spawnSync(['sh', '-euc', `ok(){ :; }; warn(){ :; }; . "$0"; rc=0; merge_log_opts "$1" || rc=$?; echo "rc=$rc"`, lib, file], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const text = r.stdout.toString();
  const m = /rc=(\d+)\n$/.exec(text);
  return { out: text.replace(/rc=\d+\n$/, ''), code: m ? Number(m[1]) : -1 };
}

describe('daemon.json log-opts merge (installer + join script)', () => {
  it('writes the bounded default when daemon.json is missing or empty', () => {
    for (const c of [null, '', '  \n']) {
      const r = merge(c);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ 'log-driver': 'json-file', 'log-opts': { 'max-size': '10m', 'max-file': '3' } });
    }
  }, 30_000);

  it('merges into existing settings without dropping them', () => {
    const r = merge('{"registry-mirrors": ["https://mirror.example"], "live-restore": true}');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      'registry-mirrors': ['https://mirror.example'],
      'live-restore': true,
      'log-driver': 'json-file',
      'log-opts': { 'max-size': '10m', 'max-file': '3' },
    });
  }, 30_000);

  it("never touches an operator's own log configuration", () => {
    expect(merge('{"log-driver": "local"}').code).toBe(3);
    expect(merge('{"log-opts": {"max-size": "100m"}}').code).toBe(3);
  }, 30_000);

  it('refuses to merge JSON it cannot parse as an object', () => {
    expect(merge('[1,2]').code).toBe(2);
    expect(merge('{not json').code).toBe(2);
  }, 30_000);
});

describe('log rotation is wired into both installers', () => {
  it('install-swarmy.sh carries the SAME snippet (no drift) and runs it after Docker', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain(DOCKER_LOG_OPTS_SH);
    expect(script).toMatch(/ensure_docker;\s+marker_set docker; }\n\s+(with_public_umask )?ensure_docker_log_opts/);
    // The agent + mesh containers the installer starts are bounded too.
    expect(script.match(/--log-opt max-size=10m --log-opt max-file=3/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the worker join script merges log-opts and bounds the agent container', () => {
    const s = renderInstaller({
      controllerUrl: 'https://swarmy.example',
      version: '1.0.0',
      agentImage: 'ghcr.io/x/agent:1',
      binaryBaseUrl: 'https://cdn.example',
      binarySha256: { 'linux-x64': 'a'.repeat(64) },
    });
    expect(s).toContain(DOCKER_LOG_OPTS_SH);
    expect(s).toContain(`${DOCKER_LOG_OPTS_SH}ensure_docker_log_opts\n`);
    expect(s).toContain(DOCKER_RUN_LOG_FLAGS);
    expect(Bun.spawnSync(['sh', '-n', '-c', s]).exitCode).toBe(0);
  }, 30_000);
});
