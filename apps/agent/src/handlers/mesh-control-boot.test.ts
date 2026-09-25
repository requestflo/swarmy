import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESH_CONTROL_CONF_VOLUME, MESH_CONTROL_ENTRYPOINT, controlNeedsRecreate } from './mesh-control';

const INSTALLER = readFileSync(join(import.meta.dir, '../../../../scripts/install-swarmy.sh'), 'utf8');
const IMAGE = 'ghcr.io/netbirdio/netbird-server:0.79.0';
const CONF_BIND = `${MESH_CONTROL_CONF_VOLUME}:/var/lib/swarmy-mesh-conf`;

describe('mesh control plane cold boot (QA-066 d: no agent, overlay or swarm on the boot path)', () => {
  test('the entrypoint seeds an empty tmpfs from the persisted copy before waiting', () => {
    const script = MESH_CONTROL_ENTRYPOINT[2]!;
    const seed = script.indexOf('cp /var/lib/swarmy-mesh-conf/config.yaml');
    const wait = script.indexOf('while [ ! -s /run/swarmy-mesh/config.yaml ]');
    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(wait);
    // Only when the tmpfs is empty: never over a config the agent just wrote.
    expect(script).toContain('if [ ! -s /run/swarmy-mesh/config.yaml ] && [ -s /var/lib/swarmy-mesh-conf/config.yaml ]');
    expect(script.startsWith('umask 077;')).toBe(true);
  });

  test('the installer runs the very same script and mounts the persisted-config volume', () => {
    const m = /^MESH_CONTROL_SCRIPT='(.*)'$/m.exec(INSTALLER);
    expect(m?.[1]).toBe(MESH_CONTROL_ENTRYPOINT[2]);
    expect(INSTALLER).toContain(`-v ${CONF_BIND} \\`);
    expect(INSTALLER).toContain('-c "$MESH_CONTROL_SCRIPT"');
  });

  test('a container from before the fix is re-created once; an up-to-date one is kept', () => {
    const good = {
      Config: { Entrypoint: MESH_CONTROL_ENTRYPOINT, Cmd: [], Labels: { 'swarmy.mesh.control.image': IMAGE } },
      HostConfig: { Binds: ['swarmy-mesh-control:/var/lib/netbird', CONF_BIND] },
    };
    expect(controlNeedsRecreate(good, IMAGE)).toBe(false);
    // The installer's `--entrypoint sh IMAGE -c '…'` splits the same argv.
    const installer = { ...good, Config: { ...good.Config, Entrypoint: ['sh'], Cmd: ['-c', MESH_CONTROL_ENTRYPOINT[2]!] } };
    expect(controlNeedsRecreate(installer, IMAGE)).toBe(false);
    expect(controlNeedsRecreate({ ...good, HostConfig: { Binds: ['swarmy-mesh-control:/var/lib/netbird'] } }, IMAGE)).toBe(true);
    const oldScript = 'while [ ! -s /run/swarmy-mesh/config.yaml ]; do sleep 0.2; done; exec /go/bin/netbird-server --config /run/swarmy-mesh/config.yaml';
    expect(controlNeedsRecreate({ ...good, Config: { ...good.Config, Entrypoint: ['sh', '-c', oldScript] } }, IMAGE)).toBe(true);
    expect(controlNeedsRecreate(good, `${IMAGE}-next`)).toBe(true);
    expect(controlNeedsRecreate(null, IMAGE)).toBe(true);
  });
});
