import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * QA-062: right after the mesh TLS handover swarmy-mesh-control restarts and
 * its Admin API (:8081) is briefly down. The bootstrap "Add a node" line minted
 * its NetBird key once, lost it, and printed a line with no SWARMY_MESH_*.
 */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

/** Source the installer, stub nb_setup_key to fail `failures` times, run the retrying mint. */
function mint(failures: number, env: Record<string, string> = {}) {
  const counter = `${process.env.TMPDIR ?? '/tmp'}/swarmy-mint-${process.pid}-${failures}-${Math.random().toString(36).slice(2)}`;
  const r = Bun.spawnSync(
    [
      'bash',
      '-c',
      `. "$0"
       nb_setup_key() { n=$(cat "$COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$COUNTER"
         if [ "$n" -lt "$FAILURES" ]; then die "could not mint a NetBird setup key: Failed to connect to 127.0.0.1 port 8081"; fi
         printf '%s' NBKEY-123; }
       nb_setup_key_retry reusable 5 86400 'swarmy bootstrap one-liner'`,
      SCRIPT,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, COUNTER: counter, FAILURES: String(failures), SWARMY_MESH_KEY_RETRY_SEC: '0', ...env } },
  );
  const calls = Number(readFileSync(counter, 'utf8').trim());
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), calls };
}

describe('installer bootstrap mesh key (QA-062)', () => {
  it('retries through a mesh-control restart and prints the key, silently', () => {
    const r = mint(3, { SWARMY_MESH_KEY_WAIT: '10' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('NBKEY-123');
    expect(r.calls).toBe(4);
    expect(r.err).toBe('');
  });

  it('gives up after the wait with the real error', () => {
    const r = mint(99, { SWARMY_MESH_KEY_WAIT: '3' });
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('port 8081');
  });

  it('the bootstrap line uses the retrying mint and warns when it has no key', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const block = script.slice(script.indexOf('# With a mesh, the bootstrap line'), script.indexOf("printf '  Add a node:  curl"));
    expect(block).toContain("nb_setup_key_retry reusable 5 86400 'swarmy bootstrap one-liner'");
    expect(block).not.toMatch(/\$\(nb_setup_key reusable/);
    expect(block).toContain('no mesh key for the line below');
  });
});
