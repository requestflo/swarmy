import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderLegacyInstallScript } from './legacy-install-sh';
import { REPAIR_ENV_SH } from './repair-env-sh';

/**
 * The legacy `GET /install.sh`: a re-run dropped the mesh key, and secrets rode
 * `docker run -e` (visible in `docker inspect` and `ps`). The rendered script
 * runs for real here, with `docker` stubbed to a call log.
 */
const render = (manager = false) =>
  renderLegacyInstallScript({ controllerUrl: 'https://ctl.example', agentImage: 'ghcr.io/x/agent:1', manager });

/** The env file of a mesh-joined node that later opted out of the mesh. */
const SAVED = `AGENT_WS_URL=wss://old.example/agent/ws
SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json
SWARMY_JOIN_TOKEN=swj_OLD
SWARMY_ALLOW_MESH=false
SWARMY_MESH_SETUP_KEY=OLD-KEY
SWARMY_MESH_MANAGEMENT_URL=https://mesh.old.example
SWARMY_MESH_DRIVER=headscale
SWARMY_MESH_CA_B64=T0xEQ0E=
`;

/** Run the script on a box with this env file / agent container env (absent = none). */
function run(box: { envFile?: string; containerEnv?: string }, given: Record<string, string>, args: string[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'swarmy-legacy-install-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh\necho "docker $*" >> "${dir}/log"\n` +
        `if [ "$1" = inspect ]; then [ -f "${dir}/container.env" ] || exit 1; [ "$2" != --format ] || cat "${dir}/container.env"; fi\nexit 0\n`,
    );
    chmodSync(path.join(bin, 'docker'), 0o755);
    const envFile = path.join(dir, 'etc-swarmy', 'agent.env');
    if (box.envFile !== undefined) {
      mkdirSync(path.dirname(envFile));
      writeFileSync(envFile, box.envFile, { mode: 0o644 });
    }
    if (box.containerEnv !== undefined) writeFileSync(path.join(dir, 'container.env'), box.containerEnv);
    writeFileSync(path.join(dir, 'install.sh'), render().replace('ENV_FILE="/etc/swarmy/agent.env"', `ENV_FILE="${envFile}"`));
    const r = Bun.spawnSync(['sh', path.join(dir, 'install.sh'), ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...given },
    });
    const raw = existsSync(envFile) ? readFileSync(envFile, 'utf8') : null;
    const env = raw === null ? null : Object.fromEntries(raw.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const log = existsSync(path.join(dir, 'log')) ? readFileSync(path.join(dir, 'log'), 'utf8') : '';
    const mode = raw === null ? 0 : statSync(envFile).mode & 0o777;
    return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString(), log, env, mode, envFile };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('legacy /install.sh re-run: the mesh settings survive (the node installer rules)', () => {
  it('a re-run with only a fresh token keeps the saved mesh key, driver and opt-out', () => {
    const r = run({ envFile: SAVED }, { SWARMY_JOIN_TOKEN: 'swj_NEW' });
    expect(r.code).toBe(0);
    expect(r.env).toMatchObject({
      SWARMY_JOIN_TOKEN: 'swj_NEW',
      SWARMY_ALLOW_MESH: 'false',
      SWARMY_MESH_SETUP_KEY: 'OLD-KEY',
      SWARMY_MESH_MANAGEMENT_URL: 'https://mesh.old.example',
      SWARMY_MESH_DRIVER: 'headscale',
      SWARMY_MESH_CA_B64: 'T0xEQ0E=',
    });
    expect(r.mode).toBe(0o600);
    expect(r.err).toContain('the mesh setup key is kept but NOT used');
    // A bare re-run (no token at all) keeps the saved token too.
    expect(run({ envFile: SAVED }, {}).env?.SWARMY_JOIN_TOKEN).toBe('swj_OLD');
  }, 30_000);

  it('a fresh mesh key replaces the mesh config as one unit (no stale URL or CA)', () => {
    const r = run({ envFile: SAVED }, { SWARMY_JOIN_TOKEN: 'swj_NEW', SWARMY_MESH_SETUP_KEY: 'NEW-KEY', SWARMY_ALLOW_MESH: 'true' });
    expect(r.env?.SWARMY_MESH_SETUP_KEY).toBe('NEW-KEY');
    expect(r.env?.SWARMY_MESH_DRIVER).toBe('netbird');
    expect(r.env?.SWARMY_MESH_MANAGEMENT_URL).toBeUndefined();
    expect(r.env?.SWARMY_MESH_CA_B64).toBeUndefined();
    expect(r.out).toContain('Mesh: joining netbird');
  }, 30_000);

  it('an install from before the env file: the settings come out of the old container env', () => {
    const containerEnv = 'PATH=/usr/bin\nSWARMY_JOIN_TOKEN=swj_OLD\nSWARMY_ALLOW_MESH=true\nSWARMY_MESH_SETUP_KEY=OLD-KEY\nSWARMY_MESH_DRIVER=netbird\n';
    const r = run({ containerEnv }, {});
    expect(r.code).toBe(0);
    expect(r.env).toMatchObject({ SWARMY_JOIN_TOKEN: 'swj_OLD', SWARMY_ALLOW_MESH: 'true', SWARMY_MESH_SETUP_KEY: 'OLD-KEY' });
    expect(r.env?.PATH).toBeUndefined();
    expect(r.mode).toBe(0o600);
  }, 30_000);
});

describe('legacy /install.sh: secrets, deprecation, uninstall', () => {
  const fresh = run({}, { SWARMY_JOIN_TOKEN: 'swj_SECRET-T', SWARMY_MESH_SETUP_KEY: 'SECRET-KEY' });

  it('secrets reach the agent only through the 0600 env file, mounted read-only', () => {
    expect(fresh.code).toBe(0);
    const runLine = fresh.log.split('\n').find((l) => l.startsWith('docker run ')) ?? '';
    expect(runLine).toContain(`-v ${fresh.envFile}:/etc/swarmy/agent.env:ro`);
    for (const leak of ['swj_SECRET-T', 'SECRET-KEY', 'SWARMY_JOIN_TOKEN', '--env-file']) expect(fresh.log).not.toContain(leak);
    expect(fresh.env).toMatchObject({ SWARMY_JOIN_TOKEN: 'swj_SECRET-T', SWARMY_MESH_SETUP_KEY: 'SECRET-KEY' });
    expect(fresh.mode).toBe(0o600);
  });

  it('prints one deprecation line on stderr pointing at the loader; stdout and exit code unchanged', () => {
    const notice = fresh.err.split('\n').filter((l) => l.includes('deprecated'));
    expect(notice).toHaveLength(1);
    const loader = 'curl -fsSL https://ctl.example/install/loader.sh | SWARMY_JOIN_TOKEN=<token> sh -s -- --controller https://ctl.example';
    expect(notice[0]).toContain(loader);
    expect(fresh.out).not.toContain('deprecated');
    expect(fresh.out + fresh.err).not.toContain('swj_SECRET-T');
  });

  it('a fresh box with no token stops before writing anything', () => {
    const r = run({}, {});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('Set SWARMY_JOIN_TOKEN');
    expect(r.env).toBeNull();
    expect(r.log).not.toContain('docker run');
  }, 30_000);

  it('--uninstall removes the container, its state volume and the env file', () => {
    const r = run({ envFile: SAVED, containerEnv: '' }, {}, ['--uninstall']);
    expect(r.code).toBe(0);
    expect(r.log).toContain('docker rm -f swarmy-agent\n');
    expect(r.log).toContain('docker volume rm swarmy-agent\n');
    expect(r.env).toBeNull();
  }, 30_000);
});

describe('renderLegacyInstallScript', () => {
  it('parses under sh and bash, with and without the manager hint', () => {
    for (const body of [render(), render(true)]) {
      for (const shell of ['sh', 'bash']) expect(Bun.spawnSync([shell, '-n', '-c', body]).exitCode).toBe(0);
    }
    expect(render(true)).toContain('swarm-manager hint');
    expect(render()).not.toContain('swarm-manager hint');
  });

  it("embeds the node installer's repair-env snippet once and bakes the defaults", () => {
    const body = render();
    expect(body.split(REPAIR_ENV_SH).length).toBe(2);
    expect(body).toContain('CONTROLLER_URL="${SWARMY_CONTROLLER_URL:-https://ctl.example}"');
    expect(body).toContain('AGENT_IMAGE="${SWARMY_AGENT_IMAGE:-ghcr.io/x/agent:1}"');
    expect(body).not.toMatch(/-e SWARMY_(JOIN_TOKEN|MESH_SETUP_KEY|MESH_CA_B64)=/);
  });
});
