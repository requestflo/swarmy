import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bullClientName, bullWorkersOf, clientNamesCommand } from './queue-workers';

/** Run the probe with a fake valkey-cli on PATH that prints `reply`. */
function runProbe(reply: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmy-queue-workers-'));
  writeFileSync(join(dir, 'reply'), reply);
  writeFileSync(join(dir, 'valkey-cli'), `#!/bin/sh\ncat '${join(dir, 'reply')}'\n`);
  chmodSync(join(dir, 'valkey-cli'), 0o755);
  const r = Bun.spawnSync(['sh', '-c', clientNamesCommand('valkey')], { env: { PATH: `${dir}:/usr/bin:/bin` } });
  return { code: r.exitCode, out: r.stdout.toString() };
}

// What the probe prints for a cache with: two unnamed `emails` workers, one
// named `mailer-1` (twice — two processes, same name), a QueueEvents, a
// `carts` worker, and clients that named nothing or something else.
const OUT = [
  ' name=bull:ZW1haWxz',
  ' name=bull:ZW1haWxz',
  ' name=bull:ZW1haWxz:w:mailer-1',
  ' name=bull:ZW1haWxz:w:mailer-1',
  ' name=bull:ZW1haWxz:qe',
  ' name=bull:Y2FydHM=',
  ' name=',
  ' name=sessions',
  '',
].join('\n');

describe('connected BullMQ workers (Queue.getWorkers)', () => {
  it('names connections the way BullMQ does: prefix + base64 queue name', () => {
    expect(bullClientName('bull', 'emails')).toBe('bull:ZW1haWxz');
    expect(bullClientName('bull', 'carts')).toBe('bull:Y2FydHM=');
  });

  it("counts a queue's workers, named or not, and never its QueueEvents", () => {
    expect(bullWorkersOf(OUT, 'bull', 'emails')).toEqual({ connected: 4, names: ['mailer-1'] });
    expect(bullWorkersOf(OUT, 'bull', 'carts')).toEqual({ connected: 1, names: [] });
    expect(bullWorkersOf(OUT, 'bull', 'thumbs')).toEqual({ connected: 0, names: [] });
    expect(bullWorkersOf('', 'bull', 'emails')).toEqual({ connected: 0, names: [] });
  });

  it('keeps only name fields in the container, and fails a reply that is not a client list', () => {
    const sh = clientNamesCommand('valkey');
    expect(sh).toContain(`valkey-cli --no-auth-warning -a "$(cat /run/secrets/cache-password)" CLIENT LIST`);
    expect(sh).toContain(`grep -o ' name=[^ ]*'`);
    expect(sh).toContain('case "$out" in id=*)');
    expect(clientNamesCommand('redis')).toContain('redis-cli');
  });

  it('the script, run against a stub CLI, prints only the names', () => {
    const list = [
      'id=3 addr=10.0.1.7:40122 laddr=10.0.1.4:6379 fd=8 name=bull:ZW1haWxz age=90 idle=0 lib-name=redis-py cmd=bzpopmin',
      'id=4 addr=10.0.1.8:40500 laddr=10.0.1.4:6379 fd=9 name= age=1 idle=0 cmd=client|list',
    ].join('\n');
    const r = runProbe(`${list}\n`);
    expect(r.code).toBe(0);
    expect(r.out).toBe(' name=bull:ZW1haWxz\n name=\n');
    expect(bullWorkersOf(r.out, 'bull', 'emails').connected).toBe(1);
    expect(runProbe('NOAUTH Authentication required.\n').code).toBe(2);
  });
});
