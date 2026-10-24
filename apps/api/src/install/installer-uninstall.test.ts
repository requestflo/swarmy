import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderInstaller } from './installer';

/**
 * Security review M15: uninstall left agent.json, the mesh sidecar and
 * state.env behind, and never rotated the swarm join tokens. Both installers
 * are run for real here, with `docker`/`systemctl`/`ip` stubbed to a call log.
 */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-uninstall-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── scripts/install-swarmy.sh --uninstall (the controller host) ───────────────

/** Shell-function stubs (sourced runs resolve functions before PATH). */
const STUBS = `
docker() {
  echo "docker $*" >> "$LOG"
  case "$1 \${2:-}" in
    "volume inspect") case " $VOLS " in *" $3 "*) return 0 ;; esac; return 1 ;;
    "info --format") case "$3" in *ControlAvailable*) echo true ;; *LocalNodeState*) echo active ;; esac ;;
  esac
  return 0
}
systemctl() { echo "systemctl $*" >> "$LOG"; }
ip() { echo "ip $*" >> "$LOG"; }
need_root() { :; }
sleep() { :; }
`;

function controllerUninstall(dir: string, flags: string[], vols: string[], opts: { state?: boolean } = {}) {
  const st = path.join(dir, 'install');
  mkdirSync(st, { recursive: true, mode: 0o700 });
  if (opts.state !== false) writeFileSync(path.join(st, 'state.env'), 'SWARMY_SECRET_KEY=k\n', { mode: 0o600 });
  writeFileSync(path.join(st, 'add-node.txt'), 'curl … SWARMY_JOIN_TOKEN=swt_x …\n', { mode: 0o600 });
  writeFileSync(path.join(st, 'admin-password'), 'pw\n', { mode: 0o600 });
  writeFileSync(path.join(st, 'netbird-setup-key'), 'key\n', { mode: 0o600 });
  mkdirSync(path.join(dir, 'etc-swarmy'));
  writeFileSync(path.join(dir, 'etc-swarmy', 'agent.env'), 'SWARMY_JOIN_TOKEN=swt_x\n', { mode: 0o600 });
  const setup =
    `${STUBS}LOG=${dir}/log; VOLS='${vols.join(' ')}'; : > "$LOG"; ` +
    `STATE_DIR=${st}; STATE_FILE=${st}/state.env; ADD_NODE_OUT=${st}/add-node.txt; ADMIN_PASSWORD_OUT=${st}/admin-password; ` +
    `AGENT_ENV_FILE=${dir}/etc-swarmy/agent.env; do_uninstall`;
  const r = Bun.spawnSync(['bash', '-c', `. "$0" "$@"; ${setup}`, SCRIPT, '--uninstall', '--non-interactive', ...flags], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  const log = existsSync(path.join(dir, 'log')) ? readFileSync(path.join(dir, 'log'), 'utf8') : '';
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), log, st };
}

describe('install-swarmy.sh --uninstall (M15)', () => {
  const DATA = ['swarmy_swarmy-data', 'swarmy-mesh-control'];

  it('refuses to delete data non-interactively without --yes, before removing anything', () => {
    withDir((dir) => {
      const r = controllerUninstall(dir, [], DATA);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('nothing removed');
      expect(r.out).toContain('volume swarmy_swarmy-data');
      expect(r.log).not.toMatch(/docker (rm|volume rm|stack rm|secret rm|swarm join-token)/);
      expect(existsSync(`${r.st}/state.env`)).toBe(true);
      expect(existsSync(`${dir}/etc-swarmy/agent.env`)).toBe(true);
    });
  }, 30_000);

  it('--yes removes credentials, the mesh and the data, and rotates both join tokens', () => {
    withDir((dir) => {
      const r = controllerUninstall(dir, ['--yes'], DATA);
      expect(r.code).toBe(0);
      for (const call of [
        'docker rm -f swarmy-agent',
        'docker volume rm swarmy-agent', // agent.json lives on it
        'docker stack rm swarmy',
        'docker secret rm swarm_manager_token',
        'docker swarm join-token --rotate -q worker',
        'docker swarm join-token --rotate -q manager',
        'docker rm -f swarmy-mesh-control swarmy-mesh-litestream swarmy-mesh-front swarmy-netbird swarmy-tailscale',
        'docker volume rm swarmy-netbird', // the sidecar's WireGuard identity
        'docker volume rm swarmy-mesh-control',
        'docker volume rm swarmy-mesh-control-conf',
        'docker volume rm swarmy_swarmy-data',
        'ip link del swarmy-mesh0',
      ]) {
        expect(r.log).toContain(`${call}\n`);
      }
      expect(existsSync(r.st)).toBe(false); // state.env, the saved one-liner, the password file
      expect(existsSync(`${dir}/etc-swarmy/agent.env`)).toBe(false);
    });
  }, 30_000);

  it('--keep-data keeps the store, state.env and the mesh, but still drops credentials and rotates', () => {
    withDir((dir) => {
      const r = controllerUninstall(dir, ['--keep-data'], DATA);
      expect(r.code).toBe(0);
      expect(r.log).toContain('docker rm -f swarmy-agent\n');
      expect(r.log).toContain('docker volume rm swarmy-agent\n');
      expect(r.log).toContain('docker stack rm swarmy\n');
      expect(r.log).toContain('docker swarm join-token --rotate -q worker\n');
      expect(r.log).not.toContain('docker volume rm swarmy_swarmy-data');
      expect(r.log).not.toMatch(/docker rm -f .*swarmy-(mesh-control|netbird)/);
      expect(r.log).not.toMatch(/docker volume rm swarmy-(mesh-control|netbird)/);
      expect(r.log).not.toContain('ip link del');
      expect(readFileSync(`${r.st}/state.env`, 'utf8')).toBe('SWARMY_SECRET_KEY=k\n');
      for (const f of ['add-node.txt', 'admin-password', 'netbird-setup-key']) expect(existsSync(`${r.st}/${f}`)).toBe(false);
      expect(existsSync(`${dir}/etc-swarmy/agent.env`)).toBe(false);
      expect(r.out).toContain('Kept for a re-install');
    });
  }, 30_000);

  it('state.env alone counts as data (it holds SWARMY_SECRET_KEY); with no data there is nothing to confirm', () => {
    withDir((dir) => {
      const r = controllerUninstall(dir, [], []);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('state.env (holds SWARMY_SECRET_KEY)');
    });
    withDir((dir) => {
      const r = controllerUninstall(dir, [], [], { state: false });
      expect(r.code).toBe(0);
      expect(r.log).toContain('docker stack rm swarmy\n');
    });
  }, 30_000);

  it('a re-install records the live (rotated) join tokens on every run', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toMatch(/marker_done swarm +\|\| \{ ensure_swarm; +marker_set swarm; \}\n\s+record_swarm_tokens/);
    expect(script.indexOf('record_swarm_tokens   #')).toBeLessThan(script.indexOf('\n  ensure_docker_secrets\n'));
  });
});

// ── the node installer's --uninstall (apps/api/src/install/installer.ts) ──────

function nodeUninstall(dir: string, flags: string[], opts: { meshControl?: boolean } = {}) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/log"\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub(
    'docker',
    opts.meshControl
      ? 'case "$1 $2 $3" in "container inspect swarmy-mesh-control"|"volume inspect swarmy-mesh-control") exit 0 ;; esac; case "$1 $2" in "container inspect"|"volume inspect") exit 1 ;; esac; exit 0'
      : 'case "$1 $2" in "container inspect"|"volume inspect") exit 1 ;; esac; exit 0',
  );
  stub('systemctl', '[ "$1" = list-unit-files ] && echo "swarmy-agent.service enabled"; exit 0');
  stub('ip', 'exit 0');
  const state = path.join(dir, 'var-lib-swarmy');
  mkdirSync(path.join(state, 'mesh-control'), { recursive: true });
  for (const f of ['agent.json', 'agent.sock', 'overlay-heal.json']) writeFileSync(path.join(state, f), '{}');
  writeFileSync(path.join(state, 'mesh-control', 'config.yaml'), 'secret');
  mkdirSync(path.join(dir, 'etc-swarmy'));
  writeFileSync(path.join(dir, 'etc-swarmy', 'agent.env'), 'SWARMY_JOIN_TOKEN=swt_x\n');
  writeFileSync(path.join(dir, 'swarmy-agent-bin'), '');
  const script = renderInstaller({
    controllerUrl: 'https://swarmy.example',
    version: '1.0.0',
    agentImage: 'ghcr.io/x/agent:1',
    binaryBaseUrl: 'https://cdn.example',
    binarySha256: {},
  })
    .replace('BIN_PATH="/usr/local/bin/swarmy-agent"', `BIN_PATH="${dir}/swarmy-agent-bin"`)
    .replace('ENV_FILE="/etc/swarmy/agent.env"', `ENV_FILE="${dir}/etc-swarmy/agent.env"`)
    .replace('STATE_DIR="/var/lib/swarmy"', `STATE_DIR="${state}"`);
  writeFileSync(path.join(dir, 'install.sh'), script);
  const r = Bun.spawnSync(['sh', path.join(dir, 'install.sh'), '--uninstall', ...flags], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  });
  const log = existsSync(path.join(dir, 'log')) ? readFileSync(path.join(dir, 'log'), 'utf8') : '';
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), log, state };
}

describe('node installer --uninstall (M15)', () => {
  it('removes the agent, its session + state, the mesh sidecar and its identity, the pin', () => {
    withDir((dir) => {
      const r = nodeUninstall(dir, []);
      expect(r.code).toBe(0);
      expect(r.log).toContain('systemctl disable --now swarmy-agent.service\n');
      expect(r.log).toContain('docker rm -f swarmy-agent swarmy-netbird swarmy-tailscale swarmy-mesh-front\n');
      expect(r.log).toContain('docker volume rm swarmy-agent\n');
      expect(r.log).toContain('docker volume rm swarmy-netbird\n');
      expect(r.log).toContain('ip link del swarmy-mesh0\n');
      expect(r.log).not.toContain('swarm join-token'); // rotation is a cluster decision (see the installer comment)
      expect(r.log).not.toContain('swarm leave');
      expect(existsSync(r.state)).toBe(false); // agent.json, agent.sock, mesh-control copy: all gone
      expect(existsSync(`${dir}/etc-swarmy/agent.env`)).toBe(false);
      expect(existsSync(`${dir}/swarmy-agent-bin`)).toBe(false);
    });
  }, 30_000);

  it('the mesh control plane host: refuses without --keep-data/--yes; --keep-data keeps it; --yes deletes it', () => {
    withDir((dir) => {
      const r = nodeUninstall(dir, [], { meshControl: true });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('Nothing was removed');
      expect(r.log).not.toMatch(/docker (rm|volume rm)/);
      expect(existsSync(`${r.state}/agent.json`)).toBe(true);
    });
    withDir((dir) => {
      const r = nodeUninstall(dir, ['--keep-data'], { meshControl: true });
      expect(r.code).toBe(0);
      expect(r.log).not.toContain('docker rm -f swarmy-mesh-control');
      expect(r.log).not.toContain('docker volume rm swarmy-mesh-control');
      expect(readFileSync(`${r.state}/mesh-control/config.yaml`, 'utf8')).toBe('secret');
      expect(existsSync(`${r.state}/agent.json`)).toBe(false);
      expect(r.log).toContain('docker volume rm swarmy-netbird\n');
    });
    withDir((dir) => {
      const r = nodeUninstall(dir, ['--yes'], { meshControl: true });
      expect(r.code).toBe(0);
      expect(r.log).toContain('docker rm -f swarmy-mesh-control swarmy-mesh-litestream\n');
      expect(r.log).toContain('docker volume rm swarmy-mesh-control\n');
      expect(r.log).toContain('docker volume rm swarmy-mesh-control-conf\n');
      expect(existsSync(r.state)).toBe(false);
    });
  }, 30_000);

  it('the rendered installer still parses under sh', () => {
    const s = renderInstaller({
      controllerUrl: 'https://swarmy.example',
      version: '1.0.0',
      agentImage: 'ghcr.io/x/agent:1',
      binaryBaseUrl: 'https://cdn.example',
      binarySha256: {},
    });
    expect(Bun.spawnSync(['sh', '-n', '-c', s]).exitCode).toBe(0);
  });
});
