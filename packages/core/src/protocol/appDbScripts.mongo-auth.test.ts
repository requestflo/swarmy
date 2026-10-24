/**
 * Mongo dump/restore never put the password on argv (`ps` would show it to
 * anything on the node). Scripts run under /bin/sh with a stub mongodump /
 * mongorestore that records its argv, its stdin, and any --config file. The
 * real sh runs are slow under a busy `bun run test`, hence the 20 s timeouts.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpScript, loadScript } from './appDbScripts';

const PW = "s3cr3t-'pw";

/** A stub tool: `--help` advertises --config or not; a run records argv, stdin and the config. */
const stub = (withConfig: boolean) =>
  [
    '#!/bin/sh',
    `case "$1" in --help) ${withConfig ? "echo '  --config=<file>'" : "echo '  --archive=<file>'"}; exit 0;; esac`,
    'printf "%s\\n" "$*" >> "$LOG_DIR/argv"',
    'IFS= read -r line && printf "%s\\n" "$line" >> "$LOG_DIR/stdin" || true',
    'for a in "$@"; do case "$a" in --config=*) cat "${a#--config=}" >> "$LOG_DIR/config";; esac; done',
  ].join('\n');

function run(script: string, opts: { withConfig: boolean; tmpfs: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'swarmy-mongo-auth-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (opts.tmpfs) mkdirSync(join(dir, 'shm'));
  for (const t of ['mongodump', 'mongorestore']) writeFileSync(join(bin, t), stub(opts.withConfig), { mode: 0o755 });
  writeFileSync(join(dir, 'dump.archive'), '');
  const body = script.replaceAll('/swarmy-dump', dir).replaceAll('/dev/shm', join(dir, 'shm')).replaceAll('/tmp/swarmy-mongo.log', join(dir, 'tool.log'));
  const r = spawnSync('/bin/sh', ['-c', body], {
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, LOG_DIR: dir, SWARMY_DB_USER: 'root', SWARMY_DB_PASSWORD: PW, SWARMY_MODE: 'in-place' },
    encoding: 'utf8',
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  return { code: r.status, err: r.stderr, argv: read('argv'), stdin: read('stdin'), config: read('config') };
}

describe('mongo dump/restore credentials', () => {
  for (const [name, script] of [['dump', dumpScript('mongo', 'root')], ['restore', loadScript('mongo')]] as const) {
    it(`${name}: tools with --config get a tmpfs config file`, () => {
      const r = run(script, { withConfig: true, tmpfs: true });
      expect(r.code).toBe(0);
      expect(r.argv).toContain('--username=root');
      expect(r.argv).not.toContain(PW);
      expect(r.config).toBe("password: 's3cr3t-''pw'\n");
      expect(r.stdin).toBe('');
    }, 20_000);

    it(`${name}: tools without --config (or no tmpfs) read the password from stdin, never argv`, () => {
      for (const opts of [{ withConfig: false, tmpfs: true }, { withConfig: true, tmpfs: false }]) {
        const r = run(script, opts);
        expect(r.code).toBe(0);
        expect(r.argv).toContain('--username=root');
        expect(r.argv).not.toContain(PW);
        expect(r.argv).not.toContain('--password');
        expect(r.stdin).toBe(`${PW}\n`);
      }
    }, 20_000);
  }

  it('no user: no password anywhere', () => {
    expect(dumpScript('mongo', 'root')).not.toContain('--password=');
    expect(loadScript('mongo')).not.toContain('--password=');
  });
});
