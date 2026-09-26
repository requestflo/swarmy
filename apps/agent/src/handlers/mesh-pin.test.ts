import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MESH_PIN_DOCKER_DROPIN,
  MESH_PIN_SERVICE,
  MESH_PIN_SH,
  meshPinFor,
  misKeyedSAs,
  nativeHostArgv,
  renderMeshPinInstall,
} from './mesh-pin';

const INSTALLER = join(import.meta.dir, '../../../../scripts/install-swarmy.sh');

describe('mesh pin (QA-059: the swarm stays on the mesh after a reboot)', () => {
  test('meshPinFor turns the NetBird address into ip + network prefix', () => {
    expect(meshPinFor('100.74.144.211/16')).toEqual({ ip: '100.74.144.211', prefix: '100.74.0.0/16' });
    expect(meshPinFor('100.119.7.9/10')).toEqual({ ip: '100.119.7.9', prefix: '100.64.0.0/10' });
    expect(meshPinFor('100.74.144.211')).toBeNull();
    expect(meshPinFor('bogus/16')).toBeNull();
    expect(meshPinFor(undefined)).toBeNull();
  });

  test('misKeyedSAs: the exact state seen on the rebooted node, and a healthy one', () => {
    const local = ['127.0.0.1', '192.168.5.15', '192.168.64.15', '100.74.144.211', '172.17.0.1'];
    const broken = 'src 100.74.240.179 dst 192.168.64.15\nsrc 192.168.64.15 dst 100.74.240.179\n';
    expect(misKeyedSAs(broken, local, '100.74.144.211')).toEqual(['src 100.74.240.179 dst 192.168.64.15', 'src 192.168.64.15 dst 100.74.240.179']);
    const healthy = 'src 100.74.144.211 dst 100.74.240.179\nsrc 100.74.240.179 dst 100.74.144.211\n';
    expect(misKeyedSAs(healthy, local, '100.74.144.211')).toEqual([]);
    expect(misKeyedSAs('', local, '100.74.144.211')).toEqual([]);
  });

  test('the pin runs before docker, and docker waits for it', () => {
    expect(MESH_PIN_SERVICE).toContain('Before=docker.service');
    expect(MESH_PIN_SERVICE).toContain('Type=oneshot');
    expect(MESH_PIN_DOCKER_DROPIN).toContain('After=swarmy-mesh-pin.service');
    expect(MESH_PIN_DOCKER_DROPIN).toContain('Wants=swarmy-mesh-pin.service');
    // low priority: never beats wt0's own route
    expect(MESH_PIN_SH).toContain('metric 4242');
    expect(MESH_PIN_SH).toContain('src "${MESH_IP}"');
  });

  test('renderMeshPinInstall carries the pin and refuses junk', () => {
    const s = renderMeshPinInstall({ ip: '100.74.144.211', prefix: '100.74.0.0/16' });
    const env = Buffer.from(s.match(/printf '%s' '([^']+)' \| base64 -d > \/etc\/swarmy\/mesh-pin.env/)![1]!, 'base64').toString();
    expect(env).toBe('MESH_IP=100.74.144.211\nMESH_PREFIX=100.74.0.0/16\n');
    expect(() => renderMeshPinInstall({ ip: '1.2.3.4; rm -rf /', prefix: '1.2.3.0/24' })).toThrow();
  });

  test('the installer installs byte-identical files (so node #1 is pinned before its agent exists)', () => {
    const sh = readFileSync(INSTALLER, 'utf8');
    const body = (tag: string) => sh.match(new RegExp(`<<'${tag}'\\n([\\s\\S]*?)${tag}\\n`))![1];
    expect(body('SWARMY_PIN_SH')).toBe(MESH_PIN_SH);
    expect(body('SWARMY_PIN_UNIT')).toBe(MESH_PIN_SERVICE);
    expect(body('SWARMY_PIN_DROPIN')).toBe(MESH_PIN_DOCKER_DROPIN);
  });

  test('installer mesh_pin_prefix agrees with meshPinFor', () => {
    for (const [ip, bits] of [['100.74.144.211', 16], ['100.119.7.9', 10], ['10.9.8.7', 20]] as const) {
      const r = Bun.spawnSync(['bash', '-c', `. "$0"; mesh_pin_prefix ${ip} ${bits}`, INSTALLER], { stdout: 'pipe' });
      expect(r.stdout.toString()).toBe(meshPinFor(`${ip}/${bits}`)!.prefix);
    }
  }, 30_000);
});

describe('native host exec (QA-075: a disk mount must land in the HOST mount namespace)', () => {
  test('a sandboxed agent (private mount namespace) enters PID 1\'s mount namespace', () => {
    const argv = nativeHostArgv('mount /x', { self: 'mnt:[4026532301]', host: 'mnt:[4026531841]' });
    expect(argv).toEqual(['nsenter', '-t', '1', '-m', '--', 'sh', '-c', 'mount /x']);
  });
  test('when the namespace cannot be read, it still goes through PID 1', () => {
    expect(nativeHostArgv('true', { self: null, host: 'mnt:[1]' }).slice(0, 5)).toEqual(['nsenter', '-t', '1', '-m', '--']);
    expect(nativeHostArgv('true', { self: 'mnt:[1]', host: null })[0]).toBe('nsenter');
  });
  test('already in the host namespace: plain sh', () => {
    expect(nativeHostArgv('true', { self: 'mnt:[4026531841]', host: 'mnt:[4026531841]' })).toEqual(['sh', '-c', 'true']);
  });
});
