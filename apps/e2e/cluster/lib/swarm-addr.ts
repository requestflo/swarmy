/**
 * Each node must advertise to the swarm an address the OTHER nodes can reach:
 * its fabric IP (with no mesh). A worker that advertises anything else — the
 * container agent once picked its own bridge IP, 172.17.0.x — still shows
 * Ready (it dials the manager), but gossip and VXLAN go nowhere: service DNS
 * and traffic across nodes fail minutes later, in templates/dns/postgres, as
 * timeouts. Checking it right after the join names the cause in seconds.
 */
import type { Cluster } from './cluster';

/** Throws naming every node whose advertise address isn't its fabric IP. → summary */
export async function assertAdvertiseAddrs(c: Cluster): Promise<string> {
  // With a mesh the swarm rides the mesh IPs, which the harness doesn't know.
  if (c.cfg.mesh !== 'none') return 'advertise addrs: mesh (not checked)';
  const bad: string[] = [];
  for (const n of c.nodes) {
    const adv = (await c.mustSh(n, `docker info -f '{{.Swarm.NodeAddr}}'`)).trim();
    if (adv !== n.fabricIp) bad.push(`${n.name} advertises ${adv || '(none)'}, its fabric IP is ${n.fabricIp}`);
  }
  if (bad.length) throw new Error(`swarm advertise address unreachable from the other nodes: ${bad.join('; ')}`);
  return 'advertise addrs = fabric IPs';
}
