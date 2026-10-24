import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderInstaller } from './installer';
import { REPAIR_ENV_SH } from './repair-env-sh';

/**
 * Regression gate for issues/manual-recovery-required-not-magical.md item 5:
 * re-running the install one-liner on an enrolled node (REPAIR mode) must keep
 * or fully replace the mesh config, never silently drop or half-mix it.
 */

/** An env file a mesh-joined node wrote on its first install. */
const EXISTING = [
  'AGENT_WS_URL=wss://old.example/agent/ws',
  'SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json',
  'SWARMY_JOIN_TOKEN=swj_OLD',
  'SWARMY_ALLOW_MESH=true',
  'SWARMY_NODE_LABELS=zone=a',
  'SWARMY_MESH_SETUP_KEY=OLD-KEY',
  'SWARMY_MESH_MANAGEMENT_URL=https://mesh.old.example',
  'SWARMY_MESH_DRIVER=netbird',
  'SWARMY_MESH_CA_B64=T0xEQ0E=',
  '',
].join('\n');

/**
 * Run the installer's salvage + write_env exactly as the installer does
 * (salvage, then the post-salvage defaults) and return the file it writes.
 */
function repair(existing: string | null, given: Record<string, string>): { env: Record<string, string>; mode: number } {
  const dir = mkdtempSync(path.join(tmpdir(), 'swarmy-repair-env-'));
  const envFile = path.join(dir, 'etc', 'agent.env');
  const lib = path.join(dir, 'lib.sh');
  writeFileSync(lib, REPAIR_ENV_SH);
  if (existing !== null) {
    Bun.spawnSync(['mkdir', '-p', path.dirname(envFile)]);
    writeFileSync(envFile, existing, { mode: 0o644 });
  }
  const vars = ['JOIN_TOKEN', 'NODE_LABELS', 'ALLOW_BUILD', 'ALLOW_MESH', 'MESH_SETUP_KEY', 'MESH_MANAGEMENT_URL', 'MESH_DRIVER', 'MESH_CA_B64'];
  const r = Bun.spawnSync(
    [
      'sh',
      '-euc',
      `. "$0"
       ENV_FILE="$1"; WS_URL=wss://new.example/agent/ws; STATE_DIR=/var/lib/swarmy
       ${vars.map((v) => `${v}="\${IN_${v}:-}"`).join('; ')}
       salvage_install_env "$ENV_FILE"
       [ -n "$ALLOW_MESH" ] || ALLOW_MESH=true
       [ -n "$MESH_DRIVER" ] || MESH_DRIVER=netbird
       write_env`,
      lib,
      envFile,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...Object.fromEntries(Object.entries(given).map(([k, v]) => [`IN_${k}`, v])) } },
  );
  if (r.exitCode !== 0) throw new Error(`sh failed: ${r.stderr.toString()}`);
  const env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { env, mode: statSync(envFile).mode & 0o777 };
}

describe('installer REPAIR env merge: the mesh config moves as one unit', () => {
  it('a fresh token + fresh mesh key fully replaces the mesh config (no stale URL or CA)', () => {
    const { env } = repair(EXISTING, { JOIN_TOKEN: 'swj_NEW', MESH_SETUP_KEY: 'NEW-KEY', MESH_DRIVER: 'netbird' });
    expect(env).toEqual({
      AGENT_WS_URL: 'wss://new.example/agent/ws',
      SWARMY_AGENT_STATE: '/var/lib/swarmy/agent.json',
      SWARMY_JOIN_TOKEN: 'swj_NEW',
      SWARMY_ALLOW_MESH: 'true',
      SWARMY_NODE_LABELS: 'zone=a',
      SWARMY_MESH_SETUP_KEY: 'NEW-KEY',
      SWARMY_MESH_DRIVER: 'netbird',
    });
  }, 30_000);

  it('a fresh key with its own management URL and CA writes exactly those', () => {
    const { env } = repair(EXISTING, {
      JOIN_TOKEN: 'swj_NEW',
      MESH_SETUP_KEY: 'NEW-KEY',
      MESH_MANAGEMENT_URL: 'https://mesh.new.example',
      MESH_CA_B64: 'TkVXQ0E=',
    });
    expect(env.SWARMY_MESH_SETUP_KEY).toBe('NEW-KEY');
    expect(env.SWARMY_MESH_MANAGEMENT_URL).toBe('https://mesh.new.example');
    expect(env.SWARMY_MESH_CA_B64).toBe('TkVXQ0E=');
  }, 30_000);

  it('a bare re-run (fresh token, no mesh vars) keeps the whole saved mesh config', () => {
    const { env, mode } = repair(EXISTING, { JOIN_TOKEN: 'swj_NEW' });
    expect(env.SWARMY_JOIN_TOKEN).toBe('swj_NEW');
    expect(env.SWARMY_MESH_SETUP_KEY).toBe('OLD-KEY');
    expect(env.SWARMY_MESH_MANAGEMENT_URL).toBe('https://mesh.old.example');
    expect(env.SWARMY_MESH_DRIVER).toBe('netbird');
    expect(env.SWARMY_MESH_CA_B64).toBe('T0xEQ0E=');
    expect(env.SWARMY_NODE_LABELS).toBe('zone=a');
    expect(mode).toBe(0o600);
  }, 30_000);

  it('a re-run with no token at all keeps the saved one', () => {
    expect(repair(EXISTING, {}).env.SWARMY_JOIN_TOKEN).toBe('swj_OLD');
  }, 30_000);

  it("keeps a node's mesh opt-out and its driver instead of resetting them to the defaults", () => {
    const optedOut = EXISTING.replace('SWARMY_ALLOW_MESH=true', 'SWARMY_ALLOW_MESH=false').replace(
      'SWARMY_MESH_DRIVER=netbird',
      'SWARMY_MESH_DRIVER=headscale',
    );
    const { env } = repair(optedOut, { JOIN_TOKEN: 'swj_NEW' });
    expect(env.SWARMY_ALLOW_MESH).toBe('false');
    expect(env.SWARMY_MESH_DRIVER).toBe('headscale');
  }, 30_000);

  it('a fresh install (no env file) gets the defaults', () => {
    const { env } = repair(null, { JOIN_TOKEN: 'swj_NEW' });
    expect(env.SWARMY_ALLOW_MESH).toBe('true');
    expect(env.SWARMY_MESH_DRIVER).toBe('netbird');
    expect(env.SWARMY_MESH_SETUP_KEY).toBeUndefined();
  }, 30_000);
});

describe('the installer embeds the repair-env snippet', () => {
  const body = renderInstaller({
    controllerUrl: 'https://ctl.example',
    version: '1.2.3',
    agentImage: 'img',
    binaryBaseUrl: 'https://ctl.example/install/bin',
    binarySha256: {},
  });

  it('defines the helpers once, before the repair block uses them, and defaults after the salvage', () => {
    expect(body.split(REPAIR_ENV_SH).length).toBe(2);
    const snippet = body.indexOf(REPAIR_ENV_SH);
    const salvage = body.indexOf('salvage_install_env "$ENV_FILE"');
    const defaults = body.indexOf('[ -n "$ALLOW_MESH" ] || ALLOW_MESH=true');
    expect(snippet).toBeGreaterThan(-1);
    expect(salvage).toBeGreaterThan(snippet);
    expect(defaults).toBeGreaterThan(salvage);
    expect(body).toContain('ALLOW_MESH="${SWARMY_ALLOW_MESH:-}"');
    expect(body).toContain('MESH_DRIVER="${SWARMY_MESH_DRIVER:-}"');
  });

  it('says so when a mesh key will be ignored', () => {
    expect(body).toContain('the mesh setup key is kept but NOT used');
  });
});
