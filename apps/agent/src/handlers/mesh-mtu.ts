/**
 * The overlay MTU check's inputs, added to the 20 s `meshState` push
 * (`interfaceMtu`, `overlays`; additive, older controllers ignore them): the
 * WireGuard interface MTU this node sees and the overlay networks its Docker
 * knows, with the MTU each was created with. Telemetry only: the controller
 * runs `checkOverlayMtu` (@swarmy/core overlay-mtu-check.ts) over every node's
 * report. Nothing here changes a network.
 */
import { readFile } from 'node:fs/promises';
import { overlaySamplesFrom, parseMtuOption, type DockerNetworkLike } from '@swarmy/core';
import type { DockerClient } from '@swarmy/core/docker';
import type { MeshStatePayload } from '@swarmy/core/protocol';
import { containerExecCapture, type ExecResult } from './mesh';

/** Interface + client container per driver (`NETBIRD_INTERFACE` / `HEADSCALE_INTERFACE` in @swarmy/mesh). */
const CLIENTS: Record<string, { iface: string; container: string }> = {
  netbird: { iface: 'wt0', container: 'swarmy-netbird' },
  headscale: { iface: 'tailscale0', container: 'swarmy-tailscale' },
};

export interface MtuDeps {
  read: (path: string) => Promise<string>;
  exec: (docker: DockerClient, container: string, cmd: string[]) => Promise<ExecResult>;
}

const realDeps: MtuDeps = { read: (p) => readFile(p, 'utf8'), exec: containerExecCapture };

/**
 * `/sys/class/net/<if>/mtu`: read on the host (the binary agent), else inside
 * the client container, which runs on the host network (the container agent
 * has its own network namespace, where wt0 doesn't exist).
 */
export async function readInterfaceMtu(
  docker: DockerClient,
  driver: string,
  deps: MtuDeps = realDeps,
): Promise<{ iface: string; mtu?: number } | null> {
  const c = CLIENTS[driver];
  if (!c) return null;
  const path = `/sys/class/net/${c.iface}/mtu`;
  const local = await deps.read(path).then(parseMtuOption, () => undefined);
  if (local) return { iface: c.iface, mtu: local };
  const r = await deps.exec(docker, c.container, ['cat', path]).catch(() => null);
  const mtu = r && r.code === 0 ? parseMtuOption(r.stdout) : undefined;
  return mtu ? { iface: c.iface, mtu } : { iface: c.iface };
}

/** The sampled state plus the MTU fields; any failure just leaves a field out. */
export async function withMeshMtu(docker: DockerClient, state: MeshStatePayload, deps: MtuDeps = realDeps): Promise<MeshStatePayload> {
  const link = await readInterfaceMtu(docker, state.driver, deps).catch(() => null);
  const nets = (await docker.docker.listNetworks({ filters: { driver: ['overlay'] } }).catch(() => null)) as DockerNetworkLike[] | null;
  return {
    ...state,
    ...(link && !state.interface ? { interface: link.iface } : {}),
    ...(link?.mtu ? { interfaceMtu: link.mtu } : {}),
    ...(nets ? { overlays: overlaySamplesFrom(nets).slice(0, 1000) } : {}),
  };
}
