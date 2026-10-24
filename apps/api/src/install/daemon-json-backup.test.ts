import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DOCKER_LOG_OPTS_SH } from './docker-log-opts';
import { DOCKER_REGISTRY_MIRROR_SH } from './docker-registry-mirror';

/**
 * Security review (Low): `daemon.json.swarmy-bak` was overwritten by the second
 * merge step, so the operator's original daemon.json was lost. Both installers
 * run the log-opts merge, then the registry-mirror merge: the backup must stay
 * the file as it was before swarmy touched it, across both steps and re-runs.
 *
 * Hermetic: PATH holds only the tools the snippets need plus a `docker` stub
 * that reports a busy node (so neither step restarts dockerd) and no
 * systemctl (so the journald drop-in is never written outside the temp dir).
 */
function hermeticBin(dir: string): string {
  const bin = path.join(dir, 'bin');
  if (existsSync(bin)) return bin;
  mkdirSync(bin);
  for (const tool of ['cat', 'cp', 'dirname', 'grep', 'mkdir', 'mktemp', 'rm', 'python3']) {
    const real = Bun.which(tool);
    if (real) symlinkSync(real, path.join(bin, tool));
  }
  const docker = path.join(bin, 'docker');
  writeFileSync(docker, '#!/bin/sh\n[ "$1" = ps ] && echo busy0123\nexit 0\n');
  chmodSync(docker, 0o755);
  return bin;
}

function runBothSteps(dir: string, file: string): { out: string; code: number } {
  const lib = path.join(dir, 'lib.sh');
  writeFileSync(lib, `${DOCKER_LOG_OPTS_SH}\n${DOCKER_REGISTRY_MIRROR_SH}`);
  const r = Bun.spawnSync(
    ['/bin/sh', '-euc', `ok(){ :; }; warn(){ echo "warn: $*"; }; . "$0"; ensure_docker_log_opts; ensure_docker_registry_mirror; echo done`, lib],
    {
      env: { PATH: hermeticBin(dir), SWARMY_DAEMON_JSON: file, TMPDIR: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  return { out: r.stdout.toString() + r.stderr.toString(), code: r.exitCode ?? -1 };
}

describe("daemon.json.swarmy-bak keeps the operator's original (both installers)", () => {
  it('survives the second merge step and a re-run', () => {
    if (!Bun.which('python3')) return; // the merge needs python3 (or jq); CI images have it
    const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-daemonjson-'));
    try {
      const file = path.join(dir, 'daemon.json');
      const original = '{"live-restore": true}\n';
      writeFileSync(file, original);

      const first = runBothSteps(dir, file);
      expect(first.out).toContain('done');
      expect(first.code).toBe(0);
      expect(readFileSync(`${file}.swarmy-bak`, 'utf8')).toBe(original);
      const merged = JSON.parse(readFileSync(file, 'utf8'));
      expect(merged['live-restore']).toBe(true);
      expect(merged['log-driver']).toBe('json-file');
      expect(merged['registry-mirrors'][0]).toBe('http://localhost:5001');

      // A re-run finds both settings present: nothing changes, the backup stays.
      expect(runBothSteps(dir, file).code).toBe(0);
      expect(readFileSync(`${file}.swarmy-bak`, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('a fresh box (no daemon.json) gets both settings and no leftover temp files', () => {
    if (!Bun.which('python3')) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-daemonjson-'));
    try {
      const file = path.join(dir, 'daemon.json');
      const r = runBothSteps(dir, file);
      expect(r.code).toBe(0);
      const merged = JSON.parse(readFileSync(file, 'utf8'));
      expect(merged['log-driver']).toBe('json-file');
      expect(merged['registry-mirrors'][0]).toBe('http://localhost:5001');
      // The merge output and the rollback copy (mktemp in TMPDIR) are cleaned up.
      expect(readdirSync(dir).filter((f) => f.startsWith('tmp.'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('neither snippet overwrites an existing backup', () => {
    for (const [sh, v] of [
      [DOCKER_LOG_OPTS_SH, 'edlo_file'],
      [DOCKER_REGISTRY_MIRROR_SH, 'edrm_file'],
    ] as const) {
      expect(sh).toContain(`[ -e "$${v}.swarmy-bak" ] || cp -p "$${v}" "$${v}.swarmy-bak"`);
      expect(sh).not.toMatch(/\[ -f "\$\w+" \] && cp -p "\$\w+" "\$\w+\.swarmy-bak"/);
    }
  });
});
