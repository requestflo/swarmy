import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { MeshStatePayload } from '@swarmy/core/protocol';
import { readInterfaceMtu, withMeshMtu, type MtuDeps } from './mesh-mtu';

const STATE = MeshStatePayload.parse({ driver: 'netbird', connected: true, meshIp: '100.92.0.4', sampledAt: 1 });

function docker(nets: unknown[] | Error): DockerClient {
  return {
    docker: { listNetworks: async () => (nets instanceof Error ? Promise.reject(nets) : nets) },
  } as unknown as DockerClient;
}

function deps(files: Record<string, string>, execOut?: { code: number; stdout: string }): MtuDeps & { execs: string[][] } {
  const execs: string[][] = [];
  return {
    execs,
    read: async (p) => {
      if (p in files) return files[p]!;
      throw new Error('ENOENT');
    },
    exec: async (_d, container, cmd) => {
      execs.push([container, ...cmd]);
      if (!execOut) throw new Error('no such container');
      return execOut;
    },
  };
}

describe('readInterfaceMtu', () => {
  it('reads the host file first (binary agent)', async () => {
    const d = deps({ '/sys/class/net/wt0/mtu': '1280\n' });
    expect(await readInterfaceMtu(docker([]), 'netbird', d)).toEqual({ iface: 'wt0', mtu: 1280 });
    expect(d.execs).toEqual([]);
  });
  it('falls back to the host-network client container (container agent)', async () => {
    const d = deps({}, { code: 0, stdout: '1280\n' });
    expect(await readInterfaceMtu(docker([]), 'headscale', d)).toEqual({ iface: 'tailscale0', mtu: 1280 });
    expect(d.execs).toEqual([['swarmy-tailscale', 'cat', '/sys/class/net/tailscale0/mtu']]);
  });
  it('no interface yet → the name only; no mesh → null', async () => {
    expect(await readInterfaceMtu(docker([]), 'netbird', deps({}, { code: 1, stdout: '' }))).toEqual({ iface: 'wt0' });
    expect(await readInterfaceMtu(docker([]), 'none', deps({}))).toBeNull();
  });
});

describe('withMeshMtu (additive meshState fields)', () => {
  it('adds the interface, its MTU and the overlays; the frame still parses', async () => {
    const out = await withMeshMtu(
      docker([
        { Name: 'shop_default', Driver: 'overlay', Attachable: true, Options: {}, Labels: { 'swarmy.managed': 'true', 'com.docker.stack.namespace': 'shop' } },
        { Name: 'swarmy', Driver: 'overlay', Attachable: true, Options: { encrypted: '', 'com.docker.network.driver.mtu': '1280' }, Labels: { 'swarmy.managed': 'true' } },
      ]),
      STATE,
      deps({ '/sys/class/net/wt0/mtu': '1280' }),
    );
    expect(out.interface).toBe('wt0');
    expect(out.interfaceMtu).toBe(1280);
    expect(out.overlays).toEqual([
      { name: 'shop_default', encrypted: false, attachable: true, managed: true, ingress: false, stack: 'shop' },
      { name: 'swarmy', mtu: 1280, encrypted: true, attachable: true, managed: true, ingress: false },
    ]);
    expect(MeshStatePayload.safeParse(out).success).toBe(true);
  });
  it('Docker or sysfs unavailable → the state goes out unchanged', async () => {
    const out = await withMeshMtu(docker(new Error('socket')), STATE, deps({}));
    expect(out).toEqual({ ...STATE, interface: 'wt0' });
  });
});
