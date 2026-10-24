import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Relays on edges (plans/epic-self-hosted-mesh-and-fleets.md §2.7
// `--mesh-relay-on-edges`): the installer hands SWARMY_MESH_RELAYS=edges to the
// controller only for --mesh swarmy behind swarmy's edge; the seed turns it
// into the managed doc's `relaysOnEdges` on a fresh install.
const ROOT = path.resolve(import.meta.dir, '../../../..');
const SCRIPT = path.join(ROOT, 'scripts/install-swarmy.sh');

function sh(expr: string, args: string[] = [], env: Record<string, string> = {}): { out: string; code: number } {
  const r = Bun.spawnSync(['bash', '-c', `set -- "$@"; . "$0"; ${expr}`, SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  return { out: r.stdout.toString(), code: r.exitCode ?? -1 };
}

describe('install-swarmy.sh --mesh-relay-on-edges', () => {
  it('mesh_relays_env says edges only for --mesh swarmy behind the edge', () => {
    expect(sh('mesh_relays_env swarmy edge edges').out).toBe('edges');
    expect(sh('mesh_relays_env swarmy letsencrypt edges')).toEqual({ out: '', code: 0 });
    expect(sh('mesh_relays_env swarmy none edges').out).toBe('');
    expect(sh('mesh_relays_env netbird-cloud edge edges').out).toBe('');
    expect(sh('mesh_relays_env swarmy edge ""').out).toBe('');
  }, 30_000);

  it('the flag and the env both set it', () => {
    expect(sh('printf %s "$MESH_RELAYS"', ['--mesh-relay-on-edges']).out).toBe('edges');
    expect(sh('printf %s "$MESH_RELAYS"', [], { SWARMY_MESH_RELAYS: 'edges' }).out).toBe('edges');
  }, 30_000);

  it('reaches the controller: the installer passes it and the stack forwards it to the seed', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('SWARMY_MESH_RELAYS="$(mesh_relays_env "$MESH" "${MESH_TLS:-}" "${MESH_RELAYS:-}")"');
    const stack = readFileSync(path.join(ROOT, 'deploy/swarmy.lite.stack.yml'), 'utf8');
    expect(stack).toContain('SWARMY_MESH_RELAYS: ${SWARMY_MESH_RELAYS:-}');
    const seed = readFileSync(path.join(ROOT, 'apps/api/src/bootstrap/seed.ts'), 'utf8');
    expect(seed).toContain("process.env.SWARMY_MESH_RELAYS === 'edges' ? { relaysOnEdges: true } : {}");
  });
});
