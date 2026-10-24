import { describe, expect, it } from 'bun:test';
import path from 'node:path';

/**
 * Security review M16: each node's registry forwarder attaches to the
 * `swarmy` overlay and registry logins cross it between nodes, so a re-run of
 * the installer flags an existing platform overlay that is not encrypted or
 * not attachable (it can't change those in place).
 */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

/** Source the installer with `docker network inspect` stubbed to report these options. */
function gaps(optionKeys: string, attachable: string): string {
  const stub = `docker() { case "$*" in *Attachable*) echo '${attachable}' ;; *Options*) echo '${optionKeys}' ;; esac; }`;
  const r = Bun.spawnSync(['bash', '-c', `. "$0"; ${stub}; overlay_security_gaps swarmy`, SCRIPT], { stdout: 'pipe', stderr: 'pipe' });
  return r.stdout.toString().trim();
}

describe('installer overlay_security_gaps', () => {
  it('an overlay the installer created (encrypted, attachable) is fine', () => {
    expect(gaps('com.docker.network.driver.mtu encrypted ', 'true')).toBe('');
  });

  it('names what an older or hand-made overlay lacks', () => {
    expect(gaps('com.docker.network.driver.mtu ', 'true')).toBe('unencrypted');
    expect(gaps('encrypted ', 'false')).toBe('unattachable');
    expect(gaps('', 'false')).toBe('unencrypted unattachable');
  });

  it('a key merely containing "encrypted" does not count', () => {
    expect(gaps('notencrypted ', 'true')).toBe('unencrypted');
  });
});
