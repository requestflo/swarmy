/**
 * Self-heal for overlay endpoints orphaned by dockerd (QA-066 b).
 *
 * The failure, found on the real cluster and reproduced on Lima: after a
 * dockerd restart, a task that crash-loops on the same node (swarmy's edge
 * failing to bind :80 behind a rescue Caddy) creates and deletes endpoints on
 * `swarmy` and `swarmy-control` every few seconds. dockerd logs "Peer entry
 * was not in db" / "cannot delete entry overlay_peer_table", and at some point
 * tears down and re-creates the network's local sandbox (`/var/run/docker/
 * netns/<n>-<netid>`) while other endpoints are still joined. Those endpoints
 * keep a veth whose peer is no longer on the live sandbox's bridge. Every
 * container on the network, and the network's load-balancer sandbox
 * (`lb_<netid>`), then shows `eth… NO-CARRIER`. VIPs and task IPs are dead
 * from that node, and it stays that way after the churn stops (watched for
 * 3 min on Lima; for good on the cluster).
 *
 * The repair QA proved works is to take every local endpoint off the network at
 * once, so dockerd drops the broken sandbox (the LB sandbox goes only when the
 * last local endpoint leaves), then let it be rebuilt. Recycling a single task
 * repairs that one container but leaves the VIP dead. So:
 *   - swarm TASK containers on an affected network are removed together,
 *     and swarm re-creates them;
 *   - other containers on it (the container agent, litestream, one-offs) are
 *     disconnected at the same moment and reconnected once the network is
 *     back, keeping their aliases. They keep running, so the agent can heal
 *     its own network.
 *
 * Gated: two sightings at least 60 s apart, per network, and at most once per
 * 30 min per node (persisted, so an agent restart can't loop it). Only overlay
 * networks. `ingress` is never touched: its sandbox is permanent and it has
 * no attachable endpoints to cycle.
 */
import { selfContainer } from '../self-container';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DockerClient } from '@swarmy/core/docker';
import { env } from '../env';
import { runOnHost } from './mesh-pin';

export const SWARM_TASK_LABEL = 'com.docker.swarm.task.id';
const MIN_SIGHTING_GAP_MS = 60_000;
const HEAL_COOLDOWN_MS = 30 * 60_000;
const RECONNECT_DEADLINE_MS = 120_000;

/** One local container as the heal sees it (from `docker inspect`). */
export interface OverlayContainer {
  id: string;
  pid: number;
  task: boolean;
  /** Network name → this container's endpoint on it. */
  networks: Record<string, { networkId: string; mac: string; aliases: string[] }>;
}

export interface OverlayNetwork {
  id: string;
  name: string;
}

/** Pure: the host script that lists NO-CARRIER links per container netns and per LB sandbox. */
export function renderCarrierProbe(pids: readonly number[]): string {
  const safe = pids.filter((p) => Number.isInteger(p) && p > 0);
  return [
    'for p in ' + (safe.length ? safe.join(' ') : '') + '; do',
    '  nsenter -t "$p" -n ip -o link 2>/dev/null | grep NO-CARRIER | sed -n "s/.*link\\/ether \\([0-9a-f:]*\\).*/PID $p \\1/p"',
    'done',
    'for ns in /var/run/docker/netns/lb_*; do',
    '  [ -e "$ns" ] || continue',
    '  nsenter --net="$ns" ip -o link 2>/dev/null | grep -q NO-CARRIER && echo "LB ${ns##*/lb_}"',
    'done',
    'true',
  ].join('\n');
}

/**
 * Pure: overlay networks with an orphaned endpoint on this node. A container
 * endpoint counts when its MAC is on a NO-CARRIER link in its netns; an LB
 * sandbox counts when `lb_<prefix>` matches the network id. `ingress` is excluded.
 */
export function brokenOverlayNetworks(
  probe: string,
  containers: readonly OverlayContainer[],
  overlays: readonly OverlayNetwork[],
): string[] {
  const names = new Set(overlays.map((n) => n.name).filter((n) => n !== 'ingress'));
  const byPid = new Map(containers.map((c) => [c.pid, c]));
  const out = new Set<string>();
  for (const m of probe.matchAll(/^PID (\d+) ([0-9a-f:]{17})$/gm)) {
    const c = byPid.get(Number(m[1]));
    if (!c) continue;
    for (const [net, ep] of Object.entries(c.networks)) {
      if (names.has(net) && ep.mac.toLowerCase() === m[2]) out.add(net);
    }
  }
  for (const m of probe.matchAll(/^LB (\S+)$/gm)) {
    const n = overlays.find((o) => o.name !== 'ingress' && m[1]!.length >= 6 && o.id.startsWith(m[1]!));
    if (n) out.add(n.name);
  }
  return [...out].sort();
}

/** Pure: what to cycle so every local endpoint leaves the broken networks at once. */
export function overlayHealPlan(
  broken: readonly string[],
  containers: readonly OverlayContainer[],
  selfId?: string,
): { remove: string[]; disconnect: { id: string; network: string; aliases: string[] }[] } {
  const remove = new Set<string>();
  const disconnect: { id: string; network: string; aliases: string[] }[] = [];
  for (const c of containers) {
    const on = broken.filter((n) => n in c.networks);
    if (!on.length) continue;
    // Never remove the agent itself, even if something labels it as a task.
    if (c.task && c.id !== selfId) {
      remove.add(c.id);
      continue;
    }
    for (const n of on) {
      const aliases = (c.networks[n]!.aliases ?? []).filter((a) => a && !c.id.startsWith(a));
      disconnect.push({ id: c.id, network: n, aliases });
    }
  }
  return { remove: [...remove].sort(), disconnect };
}

// ── the loop hook (daemon.ts, every minute, controller-independent) ──────────

const firstSeen = new Map<string, number>();
const STATE = () => path.join(path.dirname(env.STATE_PATH), 'overlay-heal.json');

interface InspectLike {
  Id: string;
  State?: { Pid?: number; Running?: boolean };
  Config?: { Labels?: Record<string, string> | null };
  HostConfig?: { NetworkMode?: string };
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID?: string; MacAddress?: string; Aliases?: string[] | null }> | null;
  };
}

async function snapshot(docker: DockerClient): Promise<{ containers: OverlayContainer[]; overlays: OverlayNetwork[] }> {
  const d = docker.docker;
  const nets = (await d.listNetworks({ filters: { driver: ['overlay'] } })) as { Id: string; Name: string }[];
  const overlays = nets.map((n) => ({ id: n.Id, name: n.Name }));
  const names = new Set(overlays.map((o) => o.name));
  const containers: OverlayContainer[] = [];
  for (const s of (await d.listContainers()) as { Id: string }[]) {
    const i = (await d.getContainer(s.Id).inspect().catch(() => null)) as InspectLike | null;
    if (!i?.State?.Running || !i.State.Pid || i.HostConfig?.NetworkMode === 'host') continue;
    const networks: OverlayContainer['networks'] = {};
    for (const [name, ep] of Object.entries(i.NetworkSettings?.Networks ?? {})) {
      if (!names.has(name) || !ep?.MacAddress) continue;
      networks[name] = { networkId: ep.NetworkID ?? '', mac: ep.MacAddress, aliases: ep.Aliases ?? [] };
    }
    if (!Object.keys(networks).length) continue;
    containers.push({ id: i.Id, pid: i.State.Pid, task: Boolean(i.Config?.Labels?.[SWARM_TASK_LABEL]), networks });
  }
  return { containers, overlays };
}

/** This agent's own container id, when it runs in one. */
async function selfContainerId(docker: DockerClient): Promise<string | undefined> {
  return (await selfContainer(docker))?.Id;
}

/**
 * Look for orphaned overlay endpoints and, once confirmed, cycle every local
 * endpoint of the affected networks. Never throws.
 */
export async function checkOverlayCarrier(docker: DockerClient, log: (m: string) => void, now = Date.now()): Promise<void> {
  try {
    const { containers, overlays } = await snapshot(docker);
    if (!containers.length) {
      firstSeen.clear();
      return;
    }
    const r = await runOnHost(docker, renderCarrierProbe(containers.map((c) => c.pid)), 30_000);
    if (r.code !== 0) return;
    const broken = brokenOverlayNetworks(r.out, containers, overlays);
    for (const n of [...firstSeen.keys()]) if (!broken.includes(n)) firstSeen.delete(n);
    if (!broken.length) return;
    const confirmed: string[] = [];
    for (const n of broken) {
      const t = firstSeen.get(n);
      if (t === undefined) {
        firstSeen.set(n, now);
        log(`overlay ${n}: endpoints without carrier on this node (QA-066); re-checking before healing`);
      } else if (now - t >= MIN_SIGHTING_GAP_MS) {
        confirmed.push(n);
      }
    }
    if (!confirmed.length) return;
    const prev = JSON.parse(await readFile(STATE(), 'utf8').catch(() => '{}')) as { at?: number };
    if (prev.at && now - prev.at < HEAL_COOLDOWN_MS) return;
    await mkdir(path.dirname(STATE()), { recursive: true }).catch(() => undefined);
    await writeFile(STATE(), JSON.stringify({ at: now, networks: confirmed }), { mode: 0o600 }).catch(() => undefined);
    for (const n of confirmed) firstSeen.delete(n);
    await healOverlays(docker, confirmed, containers, log);
  } catch (e) {
    log(`overlay carrier check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function healOverlays(
  docker: DockerClient,
  networks: string[],
  containers: OverlayContainer[],
  log: (m: string) => void,
): Promise<void> {
  const d = docker.docker;
  const plan = overlayHealPlan(networks, containers, await selfContainerId(docker));
  log(
    `overlay ${networks.join(', ')}: cycling every local endpoint (${plan.remove.length} task(s) re-created, ` +
      `${plan.disconnect.length} attachment(s) reconnected) so dockerd rebuilds the sandbox (QA-066 self-heal)`,
  );
  // All at once: the sandbox (and its LB) only goes when the LAST local endpoint leaves.
  await Promise.all([
    ...plan.disconnect.map((x) => d.getNetwork(x.network).disconnect({ Container: x.id, Force: true }).catch(() => undefined)),
    ...plan.remove.map((id) => d.getContainer(id).remove({ force: true }).catch(() => undefined)),
  ]);
  // Swarm re-creates the tasks; an attachable swarm network may be absent on a
  // worker until one of them lands, so reconnects retry until the deadline.
  const deadline = Date.now() + RECONNECT_DEADLINE_MS;
  const pending = [...plan.disconnect];
  while (pending.length && Date.now() < deadline) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const x = pending[i]!;
      const ok = await d
        .getNetwork(x.network)
        .connect({ Container: x.id, EndpointConfig: x.aliases.length ? { Aliases: x.aliases } : {} })
        .then(() => true)
        .catch((e: unknown) => /already exists|already attached/i.test(String((e as Error)?.message ?? e)));
      if (ok) pending.splice(i, 1);
    }
    if (pending.length) await new Promise((r) => setTimeout(r, 3_000));
  }
  if (pending.length) log(`overlay heal: could not reconnect ${pending.map((x) => `${x.id.slice(0, 12)}→${x.network}`).join(', ')}`);
  else log(`overlay ${networks.join(', ')}: endpoints cycled`);
}
