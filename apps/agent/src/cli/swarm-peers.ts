/**
 * Live probe of this node's `docker info .Swarm.RemoteManagers`: which listed
 * manager addresses answer on their swarm port. Shared by `rejoin --force`
 * (before/after a reform) and the doctor's swarm rung. Every call is
 * time-boxed; the decisions on top are pure (./rejoin-plan.ts).
 */
import type { DockerClient } from '@swarmy/core/docker';
import { timebox } from './context';
import { hostOf, stalePeers, type RemoteManager } from './rejoin-plan';

const INFO_TIMEOUT_MS = 5_000;
const PEER_PROBE_TIMEOUT_MS = 2_000;

export interface RemoteManagerProbe {
  remote: RemoteManager[];
  self: { nodeId?: string; nodeAddr?: string };
  /** Probed addresses; an address that was never probed counts as reachable. */
  reachable: (addr: string) => boolean;
}

/** Read RemoteManagers and TCP-probe every address in parallel (≤ ~7s total). */
export async function probeRemoteManagers(docker: DockerClient): Promise<RemoteManagerProbe> {
  const info = (await timebox(INFO_TIMEOUT_MS, () => docker.docker.info() as Promise<unknown>)) as {
    Swarm?: { NodeID?: string; NodeAddr?: string; RemoteManagers?: RemoteManager[] | null };
  } | null;
  const remote = info?.Swarm?.RemoteManagers ?? [];
  const probed = new Map<string, boolean>();
  await Promise.all(
    remote
      .filter((r) => r.Addr)
      .map(async (r) => probed.set(r.Addr!, await tcpReachable(r.Addr!, PEER_PROBE_TIMEOUT_MS))),
  );
  return {
    remote,
    self: { nodeId: info?.Swarm?.NodeID, nodeAddr: info?.Swarm?.NodeAddr },
    reachable: (a) => probed.get(a) ?? true,
  };
}

/** RemoteManagers entries that aren't us and don't answer on their swarm port. */
export async function detectStalePeers(docker: DockerClient): Promise<string[]> {
  const p = await probeRemoteManagers(docker);
  return stalePeers(p.remote, p.self, p.reachable);
}

async function tcpReachable(addr: string, ms: number): Promise<boolean> {
  const host = hostOf(addr);
  const port = Number(addr.slice(addr.lastIndexOf(':') + 1)) || 2377;
  const ok = await timebox(ms, async () => {
    const sock = await Bun.connect({ hostname: host, port, socket: { data() {}, error() {} } });
    sock.end();
    return true;
  });
  return ok === true;
}
