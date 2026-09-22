/**
 * Pure decision helpers for `swarmy-agent rejoin --force` (kept free of env /
 * Docker imports so they unit-test in isolation — see rejoin-plan.test.ts).
 *
 * The failure these guard against: `docker swarm init --force-new-cluster` on
 * a sole manager whose raft state still lists a DEAD peer address (a mesh IP
 * that was since reassigned) stalls on that peer until `context deadline
 * exceeded`, leaving the node `active` but with no working control plane.
 */

export interface RemoteManager {
  NodeID?: string;
  Addr?: string;
}

/** `host:port` → host (IPv6-in-brackets tolerant). */
export function hostOf(addr: string): string {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(addr);
  if (m) return m[1]!;
  const i = addr.lastIndexOf(':');
  return i > 0 && addr.indexOf(':') === i ? addr.slice(0, i) : addr;
}

/**
 * Peers from `docker info .Swarm.RemoteManagers` that are NOT this node and
 * did not answer a TCP probe on their swarm port. Self is matched by node id
 * or by host == this node's advertise addr (the stale entry can carry our OWN
 * node id with an old address — that is still stale, so an id match only
 * counts as self when the address matches too).
 */
export function stalePeers(
  remote: RemoteManager[],
  self: { nodeId?: string; nodeAddr?: string },
  reachable: (addr: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const r of remote) {
    if (!r.Addr) continue;
    const isSelfAddr = self.nodeAddr != null && hostOf(r.Addr) === self.nodeAddr;
    if (isSelfAddr) continue;
    if (!reachable(r.Addr)) out.push(r.Addr);
  }
  return [...new Set(out)];
}

export interface ReformAttempt {
  timedOut: boolean;
  exitCode: number | null;
  stderr: string;
}

/**
 * What to tell the operator (and whether to retry after a docker restart)
 * when `--force-new-cluster` failed. Distinguishes "stalled on a stale peer"
 * from every other failure mode.
 */
export function explainReformFailure(
  a: ReformAttempt,
  stale: string[],
  alreadyRestartedDocker: boolean,
): { message: string; retryAfterDockerRestart: boolean } {
  const deadline = a.timedOut || /context deadline exceeded|DeadlineExceeded/i.test(a.stderr);
  if (deadline && stale.length > 0) {
    return {
      message:
        `timed out talking to stale swarm peer(s) ${stale.join(', ')} — the local raft state still ` +
        'references manager addresses that no longer exist.',
      retryAfterDockerRestart: !alreadyRestartedDocker,
    };
  }
  if (deadline) {
    return {
      message: 'docker swarm init --force-new-cluster timed out (the swarm control plane looks wedged).',
      retryAfterDockerRestart: !alreadyRestartedDocker,
    };
  }
  return {
    message: `docker swarm init --force-new-cluster failed (exit ${a.exitCode ?? '?'}): ${a.stderr.trim() || 'no output'}`,
    retryAfterDockerRestart: false,
  };
}

/** Before reforming: restart dockerd first when the control plane is wedged or stale peers exist. */
export function shouldRestartDockerFirst(opts: { controlPlaneResponsive: boolean; stale: string[] }): boolean {
  return !opts.controlPlaneResponsive || opts.stale.length > 0;
}
