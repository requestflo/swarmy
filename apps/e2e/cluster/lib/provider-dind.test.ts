import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dindBoot, dindRunArgs } from './provider-dind';

const DAEMON = '{"insecure-registries":["172.18.0.1:5055"]}';
const args = () =>
  dindRunArgs({ name: 'n1', spec: { cpus: 1, memGiB: 1, diskGiB: 25 }, daemonJson: DAEMON, network: 'net', image: 'docker:29-dind', publish: false });

describe('dind node: dockerd must come back after a restart', () => {
  it('passes dockerd no flags: daemon.json is the only config (a repeated key kills dockerd)', () => {
    const a = args();
    // Everything after the image is the boot script: no dockerd argument at all.
    expect(a.slice(a.indexOf('docker:29-dind'))).toEqual(['docker:29-dind', '-c', dindBoot()]);
    expect(a.some((x) => /^--(insecure-registry|registry-mirror)/.test(x))).toBe(false);
    expect(a).toContain(`SWARMY_E2E_DAEMON_JSON=${DAEMON}`);
  });

  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Run the boot script against a stub dockerd-entrypoint.sh that prints the config it would read. */
  function boot(etc: string, bin: string) {
    const r = Bun.spawnSync(['sh', '-c', dindBoot(etc)], {
      env: { PATH: `${bin}:/usr/bin:/bin`, SWARMY_E2E_DAEMON_JSON: DAEMON },
    });
    return { code: r.exitCode, out: r.stdout.toString() };
  }

  it('seeds daemon.json on first boot and keeps what the installers merged into it on every later boot', () => {
    dir = mkdtempSync(join(tmpdir(), 'dind-boot-'));
    const etc = join(dir, 'etc-docker');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'dockerd-entrypoint.sh'), `#!/bin/sh\necho "dockerd reads: $(cat ${etc}/daemon.json)"\n`);
    chmodSync(join(bin, 'dockerd-entrypoint.sh'), 0o755);

    const first = boot(etc, bin);
    expect(first.code).toBe(0);
    expect(first.out.trim()).toBe(`dockerd reads: ${DAEMON}`);

    // install-swarmy.sh / the agent installer merge log rotation + a mirror in.
    const merged = '{"insecure-registries":["172.18.0.1:5055"],"log-opts":{"max-size":"10m"},"registry-mirrors":["http://localhost:5001"]}';
    writeFileSync(join(etc, 'daemon.json'), `${merged}\n`);
    const second = boot(etc, bin); // docker kill + docker start
    expect(second.out.trim()).toBe(`dockerd reads: ${merged}`);
    expect(readFileSync(join(etc, 'daemon.json'), 'utf8').trim()).toBe(merged);
  });
});
