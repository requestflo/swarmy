import type { NodeDetail } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { core } from './core';
import { infraextra } from './infraextra';

/**
 * Add a server, played out (board 12): a join link minted in the demo is
 * "run" on a Raspberry Pi in the garage, which phones home ~25 s later — it
 * shows up in `nodes.list`, uses the link, and (with the private network on)
 * joins it directly through the home router. A second link brings
 * home-lab-2. The link carries a demo setup key when the network is on, as
 * the controller's `generateJoinToken` does.
 */
const DELAY_MS = 25_000;

interface PhoneHome {
  pending: { tokenId: string; at: number } | null;
  arrived: number;
}

interface MeshLike {
  enabled: boolean;
  driver: string;
  managementUrl: string | null;
  peers: { id: string; nodeId: string; meshIp: string | null; status: string; lastSeen: string | null; relayed: boolean | null }[];
}

const NEWCOMERS = [
  { id: 'n-pi-garage', name: 'pi-garage', cpus: 4, memGiB: 8, arch: 'aarch64', os: 'Debian 12 (Raspberry Pi OS)', ip: '192.168.1.40' },
  { id: 'n-home-lab-2', name: 'home-lab-2', cpus: 4, memGiB: 16, arch: 'x86_64', os: 'Ubuntu 24.04', ip: '192.168.1.41' },
];

function st(store: DemoStore): PhoneHome {
  return (store.extra.phoneHome ??= { pending: null, arrived: 0 }) as PhoneHome;
}

function arrive(store: DemoStore): void {
  const s = st(store);
  if (!s.pending || Date.now() - s.pending.at < DELAY_MS) return;
  const tokenId = s.pending.tokenId;
  s.pending = null;
  const c = NEWCOMERS[s.arrived % NEWCOMERS.length]!;
  const n = s.arrived++;
  const id = n < NEWCOMERS.length ? c.id : `${c.id}-${n}`;
  const name = n < NEWCOMERS.length ? c.name : `${c.name}-${n}`;
  const now = new Date().toISOString();
  const node: NodeDetail = {
    id,
    name,
    hostname: `${name}.home.arpa`,
    role: 'worker',
    status: 'online',
    engineVersion: '27.3.1',
    os: c.os,
    arch: c.arch,
    resources: { cpus: c.cpus, memBytes: c.memGiB * 1024 ** 3 },
    agentVersion: '0.1.0',
    agentCommit: null,
    agentUpdateAvailable: false,
    lastSeenAt: now,
    live: { cpuPercent: 4, memPercent: 11 },
    ipAddress: c.ip,
    swarmNodeId: `swarm-${id}`,
    labels: { zone: 'home', 'swarmy.node.reachability': 'nat' },
    joinedAt: now,
  };
  store.nodes.push(node);
  const tokens = (store.extra.infraextra as { tokens: { id: string; usedCount: number; status: string }[] }).tokens;
  const t = tokens.find((x) => x.id === tokenId);
  if (t) Object.assign(t, { usedCount: t.usedCount + 1, status: 'exhausted' });
  const mesh = store.extra.mesh as MeshLike;
  if (mesh.enabled && mesh.driver !== 'none') {
    mesh.peers.push({ id: `peer-${id}`, nodeId: id, meshIp: `100.92.0.${40 + n}`, status: 'CONNECTED', lastSeen: now, relayed: false });
  }
}

export const phoneHome: DomainResolvers = {
  handlers: {
    'nodes.generateJoinToken': (input, store) => {
      const out = infraextra.handlers!['nodes.generateJoinToken']!(input, store) as { id: string; token: string };
      st(store).pending = { tokenId: out.id, at: Date.now() };
      const mesh = store.extra.mesh as MeshLike;
      if (!mesh.enabled || mesh.driver === 'none') return out;
      const key = out.token.slice(-12).toUpperCase();
      return { ...out, meshSetupKey: `NB-DEMO-${key}`, meshManagementUrl: mesh.managementUrl ?? undefined, meshDriver: mesh.driver };
    },
    // A fresh array each time: the store's own array is mutated in place, and
    // handing React Query the same reference would hide the newcomer.
    'nodes.list': (input, store) => {
      arrive(store);
      return [...(core.handlers!['nodes.list']!(input, store) as NodeDetail[])];
    },
  },
};
