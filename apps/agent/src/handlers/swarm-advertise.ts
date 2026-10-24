/**
 * Which address a node advertises to the swarm when the controller pins none
 * (no mesh IP): the source address of the HOST's route toward the fabric.
 *
 * Only an agent that shares the host's network namespace can read that route:
 * the binary agent, or a container on `--network host` (node #1's, QA-066 e).
 * A worker's container agent sits on the default bridge
 * (apps/api/src/install/installer.ts), where the route starts at its OWN
 * container IP (172.17.0.x). Docker accepts that address anyway, and the node
 * even shows Ready (the worker dials the manager), but gossip and VXLAN are
 * sent to an address no other node can reach: no cross-node service DNS, no
 * cross-node overlay traffic. Found by the dind cluster e2e (every dind worker
 * runs the container backend). So a bridge agent advertises nothing and lets
 * dockerd choose: on join it takes the source address of its own route to the
 * manager, from the host's namespace (moby's noderunner does the same UDP dial
 * this file does); on init it takes the host's only address, or refuses
 * loudly on a multi-homed box instead of advertising a dead one.
 */
import { existsSync } from 'node:fs';
import type { DockerClient } from '@swarmy/core/docker';
import { selfContainer } from '../self-container';
import { agentPackaging } from './update';

/**
 * Local source address the kernel would use to reach `host` — a connected UDP
 * socket makes the routing decision without sending a packet. Docker refuses
 * `swarm init` with no advertise addr on multi-homed boxes (public + private
 * NIC is the NORMAL VPS shape), so when the controller doesn't pin one we
 * default to the interface that actually reaches the fabric: the controller
 * for init, the manager for join.
 */
export async function localAddrToward(host: string, port = 53): Promise<string | undefined> {
  try {
    const s = await Bun.udpSocket({ connect: { hostname: host, port } });
    const addr = s.address.address;
    s.close();
    return addr && addr !== '0.0.0.0' ? addr : undefined;
  } catch {
    return undefined;
  }
}

/** Host part of AGENT_WS_URL — the "toward the controller" routing anchor. */
export function controllerHost(): string | undefined {
  const raw = process.env.AGENT_WS_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when this agent's routes are the host's: not in a container, or a
 * container on the host network. A container whose own inspect fails counts
 * as NOT (dockerd's own choice is never worse than a container's guess).
 */
export async function agentOnHostNetwork(docker: DockerClient): Promise<boolean> {
  if (agentPackaging() !== 'container' || !existsSync('/.dockerenv')) return true;
  const self = await selfContainer(docker).catch(() => null);
  return self?.HostConfig?.NetworkMode === 'host';
}

/** The advertise address to pin toward `host`, or undefined to let dockerd choose. */
export async function defaultAdvertiseAddr(host: string, onHostNetwork: boolean): Promise<string | undefined> {
  return onHostNetwork ? localAddrToward(host) : undefined;
}
