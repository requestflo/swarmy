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

export interface StalePeerFinding {
  /** The doctor row's one-line detail. */
  detail: string;
  hint: string;
}

/**
 * The doctor's read of stale RemoteManagers entries on an ACTIVE swarm
 * member: `null` when every listed manager answers. A dead address left in
 * the raft state is what silently broke overlay networking cluster-wide in
 * manual-recovery item 3 ("no VNI provided" on every new network, found only
 * when a deploy failed), so it is flagged as soon as doctor runs.
 */
export function stalePeerFinding(
  remote: RemoteManager[],
  self: { nodeId?: string; nodeAddr?: string },
  reachable: (addr: string) => boolean,
  role: 'manager' | 'worker',
): StalePeerFinding | null {
  const stale = stalePeers(remote, self, reachable);
  if (stale.length === 0) return null;
  const ownRecord = remote.filter((r) => r.Addr && stale.includes(r.Addr) && r.NodeID && r.NodeID === self.nodeId);
  const others = stale.filter((a) => !ownRecord.some((r) => r.Addr === a));
  const parts = [
    'Docker gossips these addresses to every node; while they are dead, creating an overlay network can fail ' +
      'with "no VNI provided", so deploys that need a new network fail.',
  ];
  if (ownRecord.length) {
    parts.push(
      `This node's own manager record still carries the old address ${ownRecord.map((r) => r.Addr).join(', ')}. ` +
        '`rejoin --force` (--force-new-cluster) keeps it; only rebuilding the swarm (leave, then a fresh init) drops it.',
    );
  }
  if (others.length) {
    parts.push(
      `If ${others.join(', ')} ${others.length === 1 ? 'is a manager' : 'are managers'} that will not come back, ` +
        'demote and remove it from a healthy manager (`docker node ls`, `docker node demote`, `docker node rm`). ' +
        'If it should be up, check the mesh / network path to it.',
    );
  }
  return {
    detail: `active (${role}), advertising ${self.nodeAddr ?? '?'}, but manager address(es) ${stale.join(', ')} do not answer`,
    hint: parts.join(' '),
  };
}

/** Before reforming: restart dockerd first when the control plane is wedged or stale peers exist. */
export function shouldRestartDockerFirst(opts: { controlPlaneResponsive: boolean; stale: string[] }): boolean {
  return !opts.controlPlaneResponsive || opts.stale.length > 0;
}
