/**
 * Retire a server ("decommission a node") — the PURE planner. Given the live
 * inventory, returns the ordered drain plan with a per-step strategy, plus the
 * blockers that stop it running and the warnings the operator must accept.
 * No IO: the runner (plans/epic-volume-mobility.md, phase 3) gathers the
 * inputs from the hub and executes the steps one at a time.
 *
 * Why a plan and not `docker node update --availability drain`: drain only
 * moves STATELESS tasks. Anything pinned to the node with a node-local volume
 * (managed Postgres/cache/search/vector members, volume-backed blueprints,
 * the registry, ClickHouse) goes `pending` forever — or, if unpinned, comes
 * back on another node with a fresh EMPTY volume. So data must move first,
 * each kind by the strategy that fits it:
 *
 *   Postgres primary   → promote a caught-up standby on another node
 *                        (existing replica, or a temporary one added first).
 *   Postgres replica   → floats; re-clones from the primary elsewhere.
 *   Cache primary      → two-pass copy (the cache saves to disk on stop).
 *   Search / vector /  → two-pass rsync: a live pass, then a short stop and a
 *   plain volumes        final pass, checksum verify, start on the target.
 *   CSI volumes        → the volume follows the task (detach/attach).
 *   Garage member      → layout change (add a replacement first if the
 *                        replication factor needs it), then wait for resync.
 *   Edge / outlet role → hand the node label to another public server; DNS
 *                        drops this server's IP before anything stops.
 *   Manager            → promote a replacement if quorum needs it, demote.
 *
 * Replacement managers, Garage members and edge servers are chosen by
 * {@link DestinationPicker.pickRoleHost} (QA-084): publicly reachable first
 * (never a NAT'd/home server unless an operator overrides it), then the
 * target's region, then free capacity, then load — and the step says why.
 *
 * The source copy is NEVER deleted by the plan: the server leaves the swarm
 * with its disk intact, so the operator can still recover from it.
 *
 * Offline target: nothing can be copied off it, so data steps flip to
 * restore-from-backup (volumes), a held failover (Postgres, via
 * `decideFailover`), or a blocker when there is no copy anywhere.
 */
import { DB_DATA_VOLUME_LABEL, DB_PIN_NODE_LABEL, PINNED_DATA_LABELS } from '@swarmy/core';
import type { SwarmNodeInfo } from '@swarmy/core/protocol';
import { GARAGE_MEMBER_NODE_LABEL } from './garage-render';

// Label strings (kept in sync with manageddb/cache/search/vector.service and
// node.service — importing those service modules would drag their IO in).
const DB_CLUSTER = 'swarmy.db.cluster';
const DB_ROLE = 'swarmy.db.role';
const DB_TOPOLOGY = 'swarmy.db.topology';
const DB_REPLICAS = 'swarmy.db.replicas';
const DB_MEMBER = 'swarmy.db.member';
const CACHE_CLUSTER = 'swarmy.cache.cluster';
const CACHE_ROLE = 'swarmy.cache.role';
const CACHE_REPLICAS = 'swarmy.cache.replicas';
const CACHE_PIN = 'swarmy.cache.node';
const SEARCH_PIN = 'swarmy.search.node';
const VECTOR_PIN = 'swarmy.vector.node';
const NODE_INGRESS = 'swarmy.node.ingress';
const NODE_OUTLET = 'swarmy.node.outlet';
const NODE_REGION = 'swarmy.region';
const NODE_PUBLIC_IP = 'swarmy.node.public-ip';
const NODE_PUBLIC_IP_OVERRIDE = 'swarmy.node.public-ip.override';
// Mirrors node.service NODE_REACHABILITY_LABEL / _OVERRIDE_LABEL.
const NODE_REACHABILITY = 'swarmy.node.reachability';
const NODE_REACHABILITY_OVERRIDE = 'swarmy.node.reachability.override';
const SERVICE_NAME_LABEL = 'com.docker.swarm.service.name';

/** A disk may not pass this after a move lands on it (node-hygiene's pressure line). */
export const DESTINATION_MAX_USED_PCT = 85;
/** A backup older than this is not a safety net for a move. */
export const SAFETY_BACKUP_MAX_AGE_MS = 24 * 60 * 60_000;
/** Images whose volume holds a database's files (the final rsync pass must run stopped). */
const DB_IMAGE_RE = /(^|\/)(postgres|pgvector|postgis|mysql|mariadb|mongo|redis|valkey|keydb|clickhouse)[:@/]|(^|\/)(postgres|mysql|mariadb|mongo|redis|valkey)$/i;
/** Anonymous volume names are 64 hex chars. */
const ANON_VOLUME_RE = /^[0-9a-f]{64}$/;

// ── inputs ─────────────────────────────────────────────────────────────────

export interface DecomNodeInput {
  /** swarmy enrollment id (`Node.id`). */
  nodeId: string;
  hostname: string;
  online: boolean;
  /** Live swarm node (Docker truth); undefined = not reported. */
  swarm?: SwarmNodeInfo;
  /** Runs the `swarmy_controller` task. */
  hostsController?: boolean;
  /** Last statfs sample of the Docker filesystem. */
  disk?: { usedBytes: number; totalBytes: number } | null;
  /** Is a peer on the mesh (so the plan must remove it there too). */
  meshPeer?: boolean;
}

export interface DecomServiceInput {
  name: string;
  mode: 'replicated' | 'global';
  desiredReplicas?: number;
  labels: Record<string, string>;
  image?: string;
}

/** A container running ON THE TARGET node (the hub's `latestContainers(target)`). */
export interface DecomContainerInput {
  name: string;
  /** Owning swarm service (`com.docker.swarm.service.name`), when a task. */
  serviceName?: string;
  labels?: Record<string, string>;
  image?: string;
  mounts?: { type?: string; source?: string; target: string }[];
}

/** Per-volume facts on the target (`volume.list` + a size probe). Optional. */
export interface DecomVolumeInput {
  name: string;
  driver?: string;
  /** Bytes used; undefined = unknown (checked again at run time). */
  sizeBytes?: number;
}

export interface DecommissionInput {
  /** Enrollment id of the server to retire. */
  targetNodeId: string;
  /** Every enrolled server, the target included. */
  nodes: readonly DecomNodeInput[];
  /** Every live swarm service (manager view). */
  services: readonly DecomServiceInput[];
  /** Containers on the target. */
  containers: readonly DecomContainerInput[];
  volumes?: readonly DecomVolumeInput[];
  /** Volume name → last SUCCEEDED backup (ms). */
  lastBackupAt?: Readonly<Record<string, number>>;
  /** Is any backup destination configured (restic target)? */
  backupsConfigured: boolean;
  /** Garage replication factor (StorageCluster.replicationFactor). */
  garageReplicationFactor?: number;
  now: number;
}

// ── outputs ────────────────────────────────────────────────────────────────

export type DrainStepKind =
  | 'safety-backup'
  | 'cordon'
  | 'manager-promote'
  | 'edge-handover'
  | 'garage-add-member'
  | 'garage-leave'
  | 'db-switchover'
  | 'db-standby-switchover'
  | 'db-failover'
  | 'volume-copy'
  | 'volume-follow'
  | 'volume-restore'
  | 'drain'
  | 'garage-await-resync'
  | 'manager-demote'
  | 'swarm-leave'
  | 'mesh-remove'
  | 'forget';

/** How long the step's subject is unreachable. */
export type Downtime = 'none' | 'seconds' | 'short' | 'unknown';

export interface DrainStep {
  /** Stable id (`<kind>:<subject>`), so a runner can resume. */
  id: string;
  kind: DrainStepKind;
  /** One plain sentence (Summary layer). */
  title: string;
  /** The mechanism (Controls/Code layers). */
  detail: string;
  /** Service / cluster / volume the step acts on. */
  subject?: string;
  volumes?: string[];
  /** Where it lands. */
  destination?: { nodeId: string; hostname: string };
  downtime: Downtime;
  /** How the runner proves the step worked before moving on. */
  verify: string;
  /** What undoing the step means (the source is kept until the plan finishes). */
  rollback: string;
  /** Bytes the step copies over the network, when known. */
  bytes?: number;
}

export type BlockerCode =
  | 'unknown-node'
  | 'not-in-swarm'
  | 'controller-host'
  | 'last-node'
  | 'no-manager-candidate'
  | 'no-destination'
  | 'data-unreachable'
  | 'unsupported-topology'
  | 'garage-no-replacement'
  | 'edge-no-replacement';

export interface Blocker {
  code: BlockerCode;
  message: string;
  /** What the operator can do about it. */
  fix?: string;
  subject?: string;
}

export interface DecommissionPlan {
  node: { nodeId: string; hostname: string; role: 'manager' | 'worker'; online: boolean };
  steps: DrainStep[];
  blockers: Blocker[];
  /** Must be acknowledged before running. */
  warnings: string[];
  /** Totals for the Summary layer. */
  totals: {
    databases: number;
    volumes: number;
    statelessServices: number;
    /** Sum of known volume sizes to copy. */
    bytesToMove: number;
    /** Volumes whose size is unknown. */
    unknownSizes: number;
  };
  /** One sentence for a novice. */
  summary: string;
  /** True when there are no blockers. */
  runnable: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────

function isSchedulable(n: DecomNodeInput): boolean {
  return Boolean(n.online && n.swarm && n.swarm.status === 'ready' && n.swarm.availability === 'active');
}

function hasPublicIp(n: DecomNodeInput): boolean {
  const l = n.swarm?.labels ?? {};
  return Boolean(l[NODE_PUBLIC_IP_OVERRIDE] || l[NODE_PUBLIC_IP]);
}

/**
 * How reachable a server is from the other servers and the internet, best
 * first. `nat` = behind NAT (a home VM, a laptop): it can dial out but nothing
 * can dial in, so it must never hold a role others depend on reaching —
 * manager, object-storage member, edge.
 */
export type Reachability = 'public' | 'probably-public' | 'unknown' | 'nat';

const REACH_RANK: Record<Reachability, number> = { public: 0, 'probably-public': 1, unknown: 2, nat: 3 };

/** A server's reachability and the plain-words reason (the plan quotes it). */
export function nodeReachability(n: DecomNodeInput): { level: Reachability; why: string } {
  const l = n.swarm?.labels ?? {};
  const override = l[NODE_REACHABILITY_OVERRIDE];
  if (override === 'public') return { level: 'public', why: 'is marked publicly reachable by an operator' };
  if (override === 'nat') return { level: 'nat', why: 'is marked as behind NAT by an operator' };
  const ip = l[NODE_PUBLIC_IP_OVERRIDE] || l[NODE_PUBLIC_IP];
  const reported = l[NODE_REACHABILITY];
  if (reported === 'nat') {
    return { level: 'nat', why: `is behind NAT (its public IP${ip ? ` ${ip}` : ''} is not on the server itself)` };
  }
  if (reported === 'public') return { level: 'public', why: `is reachable on a public address${ip ? ` (${ip})` : ''}` };
  if (ip && n.swarm?.addr === ip) return { level: 'public', why: `advertises its public address (${ip})` };
  if (ip) return { level: 'probably-public', why: `has a public IP (${ip})` };
  return { level: 'unknown', why: 'has no known public IP' };
}

function freeBytes(n: DecomNodeInput): number | undefined {
  if (!n.disk || !(n.disk.totalBytes > 0)) return undefined;
  return n.disk.totalBytes - n.disk.usedBytes;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Destination chooser shared by every data step. Stateful across one plan so
 * two moves never count the same free space twice. Rules, in order:
 * schedulable, not excluded, fits under the pressure line after the copy
 * (unknown size ⇒ fits; unknown disk ⇒ fits but ranks last), same region as
 * the target first, fewest pinned data members, most free space, id.
 */
export class DestinationPicker {
  private reserved = new Map<string, number>();
  private pinned: Map<string, number>;

  constructor(
    private readonly nodes: readonly DecomNodeInput[],
    private readonly targetNodeId: string,
    private readonly region: string | undefined,
    services: readonly DecomServiceInput[],
  ) {
    this.pinned = new Map();
    for (const s of services) {
      for (const k of PINNED_DATA_LABELS) {
        const v = s.labels[k];
        if (v) this.pinned.set(v, (this.pinned.get(v) ?? 0) + 1);
      }
    }
  }

  /** Headroom a node has for `bytes` more data, or undefined when disk is unknown. */
  private room(n: DecomNodeInput): number | undefined {
    if (!n.disk || !(n.disk.totalBytes > 0)) return undefined;
    const cap = (n.disk.totalBytes * DESTINATION_MAX_USED_PCT) / 100;
    return cap - n.disk.usedBytes - (this.reserved.get(n.nodeId) ?? 0);
  }

  /**
   * Host for a platform ROLE (replacement manager, Garage member, edge) —
   * QA-084. Ranked: publicly reachable (a NAT'd server is never chosen unless
   * an operator set `swarmy.node.reachability.override=public` on it), same
   * region as the retiring server, most free capacity, fewest data services,
   * id. Returns the pick plus a sentence saying why, and the NAT'd servers it
   * passed over so a blocker can name them.
   */
  pickRoleHost(opts: { exclude?: readonly string[]; filter?: (n: DecomNodeInput) => boolean } = {}): RoleHostPick {
    const exclude = new Set([this.targetNodeId, ...(opts.exclude ?? [])]);
    const pool = this.nodes.filter((n) => !exclude.has(n.nodeId) && isSchedulable(n) && (opts.filter?.(n) ?? true));
    const reach = new Map(pool.map((n) => [n.nodeId, nodeReachability(n)] as const));
    const natSkipped = pool.filter((n) => reach.get(n.nodeId)!.level === 'nat');
    const eligible = pool.filter((n) => reach.get(n.nodeId)!.level !== 'nat');
    const regionOf = (n: DecomNodeInput) => n.swarm?.labels[NODE_REGION];
    const sameRegion = (n: DecomNodeInput) => this.region !== undefined && regionOf(n) === this.region;
    const pinnedOn = (n: DecomNodeInput) => this.pinned.get(n.swarm?.swarmNodeId ?? '') ?? 0;
    eligible.sort(
      (a, b) =>
        REACH_RANK[reach.get(a.nodeId)!.level] - REACH_RANK[reach.get(b.nodeId)!.level] ||
        Number(sameRegion(b)) - Number(sameRegion(a)) ||
        (this.room(b) ?? -1) - (this.room(a) ?? -1) ||
        pinnedOn(a) - pinnedOn(b) ||
        a.nodeId.localeCompare(b.nodeId),
    );
    const chosen = eligible[0];
    const natNote =
      natSkipped.length > 0
        ? ` Passed over ${joinWords(natSkipped.map((n) => n.hostname))}: behind NAT, so the other servers can't reach ${natSkipped.length === 1 ? 'it' : 'them'}.`
        : '';
    if (!chosen) return { natSkipped, reason: natNote.trim() };
    const parts = [reach.get(chosen.nodeId)!.why];
    if (this.region !== undefined) {
      parts.push(sameRegion(chosen) ? `is in ${this.region} like the server it replaces` : `is outside ${this.region} (no eligible server there)`);
    }
    const free = freeBytes(chosen);
    if (free !== undefined) parts.push(`has ${formatBytes(free)} free`);
    const load = pinnedOn(chosen);
    parts.push(`runs ${load} data service${load === 1 ? '' : 's'}`);
    return { chosen, natSkipped, reason: `Chose ${chosen.hostname} because it ${joinWords(parts)}.${natNote}` };
  }

  pick(opts: { bytes?: number; exclude?: readonly string[] } = {}): DecomNodeInput | undefined {
    const exclude = new Set([this.targetNodeId, ...(opts.exclude ?? [])]);
    const candidates = this.nodes.filter((n) => {
      if (exclude.has(n.nodeId) || !isSchedulable(n)) return false;
      const room = this.room(n);
      if (room === undefined || opts.bytes === undefined) return true;
      return room >= opts.bytes;
    });
    if (candidates.length === 0) return undefined;
    const regionOf = (n: DecomNodeInput) => n.swarm?.labels[NODE_REGION];
    const pinnedOn = (n: DecomNodeInput) => this.pinned.get(n.swarm?.swarmNodeId ?? '') ?? 0;
    candidates.sort(
      (a, b) =>
        Number(this.region !== undefined && regionOf(b) === this.region) -
          Number(this.region !== undefined && regionOf(a) === this.region) ||
        pinnedOn(a) - pinnedOn(b) ||
        (this.room(b) ?? -1) - (this.room(a) ?? -1) ||
        a.nodeId.localeCompare(b.nodeId),
    );
    const chosen = candidates[0]!;
    if (opts.bytes) this.reserved.set(chosen.nodeId, (this.reserved.get(chosen.nodeId) ?? 0) + opts.bytes);
    const sw = chosen.swarm?.swarmNodeId;
    if (sw) this.pinned.set(sw, (this.pinned.get(sw) ?? 0) + 1);
    return chosen;
  }
}

export interface RoleHostPick {
  chosen?: DecomNodeInput;
  /** Schedulable candidates left out because they sit behind NAT. */
  natSkipped: DecomNodeInput[];
  /** Why this server (Controls layer; quoted in the step detail). */
  reason: string;
}

/** Blocker `fix` text when NAT'd servers were the only candidates. */
function natFix(skipped: readonly DecomNodeInput[], otherwise: string): string {
  if (skipped.length === 0) return otherwise;
  return `Add a server with a public address. If ${joinWords(skipped.map((n) => n.hostname))} really can be reached from the other servers, set ${NODE_REACHABILITY_OVERRIDE}=public on it.`;
}

function dest(n: DecomNodeInput): { nodeId: string; hostname: string } {
  return { nodeId: n.nodeId, hostname: n.hostname };
}

// ── planner ────────────────────────────────────────────────────────────────

export function planDecommission(input: DecommissionInput): DecommissionPlan {
  const blockers: Blocker[] = [];
  const warnings: string[] = [];
  const target = input.nodes.find((n) => n.nodeId === input.targetNodeId);
  if (!target) {
    return emptyPlan(
      { nodeId: input.targetNodeId, hostname: input.targetNodeId, role: 'worker', online: false },
      [{ code: 'unknown-node', message: 'That server is not enrolled in this workspace.' }],
    );
  }
  const role = target.swarm?.role ?? 'worker';
  const header = { nodeId: target.nodeId, hostname: target.hostname, role, online: target.online };
  const host = target.hostname;
  const swarmId = target.swarm?.swarmNodeId;

  if (!target.swarm && target.online) {
    return emptyPlan(header, [
      {
        code: 'not-in-swarm',
        message: `${host} is connected but has not reported its swarm membership.`,
        fix: 'Wait a minute for it to report, or remove the enrollment if it never joined.',
      },
    ]);
  }
  if (target.hostsController) {
    blockers.push({
      code: 'controller-host',
      message: `${host} runs the swarmy controller.`,
      fix: 'Move the controller to another server first (Settings → Controller), then retire this one.',
    });
  }
  const others = input.nodes.filter((n) => n.nodeId !== target.nodeId);
  if (!others.some(isSchedulable)) {
    blockers.push({
      code: 'last-node',
      message: `${host} is the only working server — there is nowhere to move its apps and data.`,
      fix: 'Add a server first.',
    });
  }

  const region = target.swarm?.labels[NODE_REGION];
  const picker = new DestinationPicker(input.nodes, target.nodeId, region, input.services);
  const serviceByName = new Map(input.services.map((s) => [s.name, s] as const));
  const volumeInfo = new Map((input.volumes ?? []).map((v) => [v.name, v] as const));
  const sizeOf = (v: string) => volumeInfo.get(v)?.sizeBytes;
  const online = target.online;

  // What runs here: service name → its containers' mounts.
  const onTarget = new Map<string, { mounts: NonNullable<DecomContainerInput['mounts']> }>();
  for (const c of input.containers) {
    const svc = c.serviceName ?? c.labels?.[SERVICE_NAME_LABEL];
    if (!svc) continue;
    const entry = onTarget.get(svc) ?? { mounts: [] };
    entry.mounts.push(...(c.mounts ?? []));
    onTarget.set(svc, entry);
  }
  // Services pinned here by a data label run here by declaration even when
  // their task is down (offline node, crash loop).
  for (const s of input.services) {
    if (swarmId && PINNED_DATA_LABELS.some((k) => s.labels[k] === swarmId) && !onTarget.has(s.name)) {
      const vol = s.labels[DB_DATA_VOLUME_LABEL];
      onTarget.set(s.name, { mounts: vol ? [{ type: 'volume', source: vol, target: '/data' }] : [] });
    }
  }

  const dataSteps: DrainStep[] = [];
  const needsBackup = new Set<string>();
  const stateless: string[] = [];
  let databases = 0;
  let volumeCount = 0;
  let bytesToMove = 0;
  let unknownSizes = 0;
  const handled = new Set<string>();

  const noDestination = (subject: string, bytes?: number) =>
    blockers.push({
      code: 'no-destination',
      subject,
      message:
        bytes !== undefined
          ? `No other server has room for ${subject} (${formatBytes(bytes)}) and stays under ${DESTINATION_MAX_USED_PCT}% full.`
          : `No other working server can take ${subject}.`,
      fix: 'Add a disk or a server, or free space on another server.',
    });

  const hasFreshBackup = (vol: string) => {
    const at = input.lastBackupAt?.[vol];
    return at !== undefined && input.now - at <= SAFETY_BACKUP_MAX_AGE_MS;
  };

  // ── managed Postgres ─────────────────────────────────────────────────────
  const clusters = new Map<string, DecomServiceInput[]>();
  for (const s of input.services) {
    const c = s.labels[DB_CLUSTER];
    if (!c || s.labels[DB_ROLE] === undefined) continue;
    const key = `${s.labels['com.docker.stack.namespace'] ?? ''}/${c}`;
    clusters.set(key, [...(clusters.get(key) ?? []), s]);
  }
  for (const [key, members] of clusters) {
    const cluster = key.split('/').pop()!;
    for (const m of members) {
      if (!onTarget.has(m.name)) continue;
      handled.add(m.name);
      const r = m.labels[DB_ROLE];
      if (r === 'replica' || r === 'dcs') {
        // Floats: drain reschedules it; a replica re-clones from the primary.
        stateless.push(m.name);
        continue;
      }
      if (r !== 'primary') continue;
      databases++;
      const topology = m.labels[DB_TOPOLOGY] ?? 'primary-replica';
      const vol = m.labels[DB_DATA_VOLUME_LABEL];
      if (topology === 'active-active' || m.labels[DB_MEMBER]) {
        blockers.push({
          code: 'unsupported-topology',
          subject: m.name,
          message: `${cluster} runs active-active; moving one of its writers is not automated yet.`,
          fix: 'Switch the cluster to primary-replica first, or move it by backup and restore.',
        });
        continue;
      }
      const replicaSvc = members.find((x) => x.labels[DB_ROLE] === 'replica');
      const replicaCount = Number(m.labels[DB_REPLICAS] ?? replicaSvc?.desiredReplicas ?? 0);
      const hasReplica = replicaCount > 0 && Boolean(replicaSvc && (replicaSvc.desiredReplicas ?? 0) > 0);
      const bytes = vol ? sizeOf(vol) : undefined;
      if (!online) {
        if (hasReplica) {
          dataSteps.push({
            id: `db-failover:${m.name}`,
            kind: 'db-failover',
            subject: m.name,
            title: `Make a copy of ${cluster} on another server the main database.`,
            detail:
              'The server is offline, so this is a failover, not a planned switchover: decideFailover promotes a replica only if it provably caught up; otherwise it holds for your confirmation (db.confirmFailover) with the data-loss window shown.',
            downtime: 'seconds',
            verify: 'pg_is_in_recovery() = false on the promoted member; apps reconnect via the -primary DNS name.',
            rollback: 'None needed: the old primary keeps its disk and rejoins as a replica (PGDATA moved aside) if it returns.',
          });
        } else if (vol && input.lastBackupAt?.[vol] !== undefined) {
          const d = picker.pick({ bytes });
          if (!d) noDestination(cluster, bytes);
          else
            dataSteps.push({
              id: `volume-restore:${m.name}`,
              kind: 'volume-restore',
              subject: m.name,
              volumes: [vol],
              destination: dest(d),
              title: `Restore ${cluster} from its last backup onto ${d.hostname}.`,
              detail: `The server is offline and the database has no replica. Restores the newest snapshot of ${vol}; writes after that backup are lost.`,
              downtime: 'unknown',
              verify: 'restic restore exit 0, then the member starts and answers pg_isready.',
              rollback: 'Point the cluster back at the old server if it returns (its disk is untouched).',
            });
        } else {
          blockers.push({
            code: 'data-unreachable',
            subject: m.name,
            message: `${cluster} lives only on ${host}, which is offline, and has no replica or backup.`,
            fix: `Bring ${host} back online first.`,
          });
        }
        continue;
      }
      if (vol && !hasFreshBackup(vol)) needsBackup.add(vol);
      if (hasReplica) {
        dataSteps.push({
          id: `db-switchover:${m.name}`,
          kind: 'db-switchover',
          subject: m.name,
          title: `Hand ${cluster}'s writes to its copy on another server.`,
          detail:
            'Planned switchover: wait for the replica to replay the primary\'s current LSN, stop writes on the old primary, SELECT pg_promote() on the replica, repoint members under a new SWARMY_PG_REJOIN epoch, then re-pin the primary label (swarmy.db.node) to the promoted member\'s node.',
          downtime: 'seconds',
          verify: 'Promoted member replay LSN ≥ old primary flush LSN before promotion; pg_is_in_recovery() = false after.',
          rollback: 'Before promotion: abort, the old primary keeps writing. After: switch back the same way (the old primary rejoins as a replica).',
        });
      } else {
        const d = picker.pick({ bytes, exclude: [] });
        if (!d) {
          noDestination(cluster, bytes);
          continue;
        }
        if (bytes !== undefined) bytesToMove += bytes;
        else unknownSizes++;
        dataSteps.push({
          id: `db-standby-switchover:${m.name}`,
          kind: 'db-standby-switchover',
          subject: m.name,
          volumes: vol ? [vol] : undefined,
          destination: dest(d),
          bytes,
          title: `Copy ${cluster} to ${d.hostname} while it keeps running, then switch over.`,
          detail:
            'Adds a temporary streaming replica pinned to the destination (pg_basebackup over the cluster network), waits until it has replayed the primary\'s current LSN, then does a planned switchover and sets the replica count back to what you declared.',
          downtime: 'seconds',
          verify: 'Standby replay LSN = primary flush LSN with writes paused; row counts of every table match.',
          rollback: 'Before switchover: remove the temporary replica. After: switch back; the old volume on this server is untouched.',
        });
      }
    }
  }

  // ── managed caches ───────────────────────────────────────────────────────
  for (const s of input.services) {
    if (!s.labels[CACHE_CLUSTER] || !onTarget.has(s.name) || handled.has(s.name)) continue;
    handled.add(s.name);
    const r = s.labels[CACHE_ROLE];
    if (r !== 'primary') {
      stateless.push(s.name);
      continue;
    }
    const cluster = s.labels[CACHE_CLUSTER];
    const replicas = Number(s.labels[CACHE_REPLICAS] ?? 0);
    if (!online) {
      warnings.push(
        replicas > 0
          ? `${cluster} (cache) is on an offline server; its replica is promoted and recent writes may be lost.`
          : `${cluster} (cache) is on an offline server with no replica; it restarts empty elsewhere.`,
      );
      stateless.push(s.name);
      continue;
    }
    // Online primaries fall through to the volume path: a runtime FAILOVER
    // would be undone by the declared spec (replicas boot with REPLICAOF the
    // primary service), so the primary's volume is copied with the cache
    // stopped for the final pass — it saves to disk on stop.
    handled.delete(s.name);
  }

  // ── Garage member ────────────────────────────────────────────────────────
  const garageMembers = input.nodes.filter((n) => n.swarm?.labels[GARAGE_MEMBER_NODE_LABEL] === 'true');
  const isGarage = target.swarm?.labels[GARAGE_MEMBER_NODE_LABEL] === 'true';
  const garageSteps: DrainStep[] = [];
  let garageResync: DrainStep | undefined;
  if (isGarage) {
    const rf = Math.max(1, input.garageReplicationFactor ?? 1);
    const remaining = garageMembers.length - 1;
    if (remaining < rf || remaining === 0) {
      const pick = picker.pickRoleHost({ exclude: garageMembers.map((n) => n.nodeId) });
      const d = pick.chosen;
      if (!d) {
        blockers.push({
          code: 'garage-no-replacement',
          message: `${host} holds object-storage data (${remaining} other member${remaining === 1 ? '' : 's'}, ${rf} ${rf === 1 ? 'copy' : 'copies'} required) and no other server can take its place.${pick.natSkipped.length ? ` ${pick.reason}` : ''}`,
          fix: natFix(pick.natSkipped, 'Add a server with enough disk, or lower the storage replication factor.'),
        });
      } else {
        garageSteps.push({
          id: `garage-add-member:${d.nodeId}`,
          kind: 'garage-add-member',
          destination: dest(d),
          title: `Make ${d.hostname} an object-storage server.`,
          detail: `Labels ${GARAGE_MEMBER_NODE_LABEL}=true on ${d.hostname}; storage-reconcile starts its Garage task, connects RPC and assigns it a zone and capacity in the layout. ${pick.reason}`,
          downtime: 'none',
          verify: 'garage status lists the new node as healthy with a role in the applied layout.',
          rollback: `Set ${GARAGE_MEMBER_NODE_LABEL}=false and remove it from the layout.`,
        });
      }
    }
    if (!online && rf <= 1) {
      blockers.push({
        code: 'data-unreachable',
        subject: 'object storage',
        message: `${host} is offline and object storage keeps only one copy — its share of buckets cannot be rebuilt.`,
        fix: `Bring ${host} back online, or restore buckets from the off-site mirror.`,
      });
    }
    garageSteps.push({
      id: `garage-leave:${target.nodeId}`,
      kind: 'garage-leave',
      title: `Move ${host}'s share of object storage to the other storage servers.`,
      detail: 'garage layout remove <node> + layout apply (one apply, after every assign/remove). Garage re-replicates the partitions this node held to the remaining members.',
      downtime: 'none',
      verify: 'The applied layout version no longer lists the node.',
      rollback: 'Re-assign the node its old role and apply; its data files are still on disk.',
    });
    garageResync = {
      id: `garage-await-resync:${target.nodeId}`,
      kind: 'garage-await-resync',
      title: 'Wait until every object has its full set of copies again.',
      detail: 'Polls the admin API until the resync queue is empty and every partition is on the new layout version; the node must stay online until then.',
      downtime: 'none',
      verify: 'garage stats: resync queue 0, no partitions below quorum.',
      rollback: 'Not needed — nothing is deleted from this server.',
    };
  }

  // ── search / vector / generic volumes ────────────────────────────────────
  const volumeSteps: DrainStep[] = [];
  const csiFollow: string[] = [];
  for (const [svcName, { mounts }] of onTarget) {
    if (handled.has(svcName)) continue;
    const svc = serviceByName.get(svcName);
    const vols = [...new Set(mounts.filter((m) => m.type === 'volume' && m.source).map((m) => m.source!))];
    const binds = mounts.filter((m) => m.type === 'bind' && m.source);
    if (svc?.mode === 'global') {
      // One task per node: it simply ends here; nothing moves.
      handled.add(svcName);
      continue;
    }
    if (isGarage && svc?.labels['com.docker.stack.namespace'] === 'swarmy-system' && /garage/.test(svcName)) {
      handled.add(svcName);
      continue;
    }
    for (const b of binds) {
      if (b.source === '/var/run/docker.sock') continue;
      warnings.push(`${svcName} uses a folder on the server itself (${b.source}); swarmy does not move folders — copy it yourself if it holds data.`);
    }
    const named = vols.filter((v) => !ANON_VOLUME_RE.test(v));
    if (vols.length > named.length) {
      warnings.push(`${svcName} has an unnamed scratch volume; its contents are dropped.`);
    }
    if (named.length === 0) {
      stateless.push(svcName);
      handled.add(svcName);
      continue;
    }
    handled.add(svcName);
    const localVols = named.filter((v) => {
      const d = volumeInfo.get(v)?.driver;
      return d === undefined || d === 'local';
    });
    const clusterVols = named.filter((v) => !localVols.includes(v));
    if (clusterVols.length > 0) csiFollow.push(...clusterVols);
    if (localVols.length === 0) {
      stateless.push(svcName);
      continue;
    }
    const pinnedByLabel = PINNED_DATA_LABELS.some((k) => swarmId && svc?.labels[k] === swarmId);
    if (!pinnedByLabel && (svc?.desiredReplicas ?? 1) > 1) {
      warnings.push(
        `${svcName} runs ${svc?.desiredReplicas} copies, each with its own volume; the copy on ${host} is dropped, not merged into another.`,
      );
      stateless.push(svcName);
      continue;
    }
    volumeCount += localVols.length;
    const known = localVols.map(sizeOf);
    const bytes = known.every((b) => b !== undefined) ? known.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined;
    const isDb = DB_IMAGE_RE.test(svc?.image ?? '');
    if (!online) {
      const backedUp = localVols.filter((v) => input.lastBackupAt?.[v] !== undefined);
      if (backedUp.length < localVols.length) {
        blockers.push({
          code: 'data-unreachable',
          subject: svcName,
          message: `${svcName}'s data lives only on ${host}, which is offline, and ${localVols.length - backedUp.length} of its volumes have no backup.`,
          fix: `Bring ${host} back online first.`,
        });
        continue;
      }
      const d = picker.pick({ bytes });
      if (!d) {
        noDestination(svcName, bytes);
        continue;
      }
      volumeSteps.push({
        id: `volume-restore:${svcName}`,
        kind: 'volume-restore',
        subject: svcName,
        volumes: localVols,
        destination: dest(d),
        bytes,
        title: `Restore ${svcName}'s data from its last backup onto ${d.hostname}.`,
        detail: 'The server is offline, so the newest restic snapshot of each volume is restored on the destination and the service is re-pinned there. Changes after that backup are lost.',
        downtime: 'unknown',
        verify: 'restic restore exit 0 per volume; the service reaches running.',
        rollback: 'Re-pin to the old server if it returns; its disk is untouched.',
      });
      continue;
    }
    for (const v of localVols) if (!hasFreshBackup(v)) needsBackup.add(v);
    const d = picker.pick({ bytes });
    if (!d) {
      noDestination(svcName, bytes);
      continue;
    }
    if (bytes !== undefined) bytesToMove += bytes;
    else unknownSizes += known.filter((b) => b === undefined).length;
    const kind = svc?.labels[CACHE_PIN] ? 'cache' : svc?.labels[SEARCH_PIN] ? 'search index' : svc?.labels[VECTOR_PIN] ? 'vector store' : isDb ? 'database files' : 'data';
    volumeSteps.push({
      id: `volume-copy:${svcName}`,
      kind: 'volume-copy',
      subject: svcName,
      volumes: localVols,
      destination: dest(d),
      bytes,
      title: `Copy ${svcName}'s ${kind} to ${d.hostname}, then restart it there.`,
      detail:
        `Two-pass copy: rsync -aHAX --numeric-ids while ${svcName} runs, then scale it to 0, a final rsync of the changes, a checksum compare, re-pin it to ${d.hostname} and scale it back.` +
        (isDb ? ' The final pass runs with the database stopped, so its files are consistent.' : ''),
      downtime: 'short',
      verify: 'Per-volume file count, byte total and a sha256 manifest match on both sides before the service starts.',
      rollback: `Re-pin ${svcName} to ${host} and scale it back; the source volume is kept until the whole plan finishes.`,
    });
  }
  if (csiFollow.length > 0) {
    volumeSteps.push({
      id: 'volume-follow:csi',
      kind: 'volume-follow',
      volumes: [...new Set(csiFollow)].sort(),
      title: 'Let the network volumes follow their apps.',
      detail: 'CSI cluster volumes (driver ≠ local) are set to drain availability; swarm detaches them here and attaches them on the node the task lands on.',
      downtime: 'seconds',
      verify: 'docker volume ls --cluster shows each volume published on the new node.',
      rollback: 'Set the volume availability back to active.',
    });
  }

  // ── edge / outlet roles ──────────────────────────────────────────────────
  const edgeSteps: DrainStep[] = [];
  for (const [label, name] of [
    [NODE_INGRESS, 'public entry point (edge)'],
    [NODE_OUTLET, 'outbound (outlet)'],
  ] as const) {
    if (target.swarm?.labels[label] !== 'true') continue;
    const peers = others.filter((n) => n.swarm?.labels[label] === 'true' && isSchedulable(n));
    if (peers.length > 0) {
      edgeSteps.push({
        id: `edge-handover:${label}`,
        kind: 'edge-handover',
        title: `Stop sending ${name} traffic to ${host}.`,
        detail: `Clears ${label} on ${host}; dns-reconcile drops its IP from the geo-DNS answers, then the plan waits one record TTL so resolvers stop using it. ${peers.map((p) => p.hostname).join(', ')} keep serving.`,
        downtime: 'none',
        verify: 'The DNS snapshot no longer contains this server\'s public IP.',
        rollback: `Set ${label}=true on ${host} again.`,
      });
      continue;
    }
    const pick = picker.pickRoleHost({ filter: hasPublicIp });
    const d = pick.chosen;
    if (!d) {
      blockers.push({
        code: 'edge-no-replacement',
        message: `${host} is the only ${name} server and no other server has a reachable public IP.${pick.natSkipped.length ? ` ${pick.reason}` : ''}`,
        fix: natFix(pick.natSkipped, 'Add a server with a public IP, or set one with the public IP override.'),
      });
      continue;
    }
    edgeSteps.push({
      id: `edge-handover:${label}`,
      kind: 'edge-handover',
      destination: dest(d),
      title: `Make ${d.hostname} the ${name} server instead of ${host}.`,
      detail: `Sets ${label}=true on ${d.hostname} and waits for its edge to answer health checks, then clears it on ${host} and waits one DNS TTL. Update any A record you manage outside swarmy to ${d.hostname}'s IP. ${pick.reason}`,
      downtime: 'seconds',
      verify: `${d.hostname} passes the edge health probe and is in the DNS snapshot; ${host} is not.`,
      rollback: `Set ${label}=true on ${host} again.`,
    });
    if (label === NODE_INGRESS) {
      warnings.push(`Domains whose DNS you manage yourself must be pointed at ${d.hostname}'s IP.`);
    }
  }

  // ── managers ─────────────────────────────────────────────────────────────
  const managerSteps: DrainStep[] = [];
  let demote: DrainStep | undefined;
  if (role === 'manager') {
    const managers = input.nodes.filter((n) => n.swarm?.role === 'manager');
    const remaining = managers.length - 1;
    const pick = picker.pickRoleHost({ filter: (n) => n.swarm?.role === 'worker' });
    const worker = pick.chosen;
    if (remaining === 0 || (remaining % 2 === 0 && worker)) {
      if (!worker) {
        blockers.push({
          code: 'no-manager-candidate',
          message: `${host} is the swarm's only manager and no other server can become one.${pick.natSkipped.length ? ` ${pick.reason}` : ''}`,
          fix: natFix(pick.natSkipped, 'Add a server first.'),
        });
      } else {
        managerSteps.push({
          id: `manager-promote:${worker.nodeId}`,
          kind: 'manager-promote',
          destination: dest(worker),
          title: `Make ${worker.hostname} a manager so the swarm keeps a working majority.`,
          detail: `docker node promote; after ${host} leaves there are ${remaining + 1} managers (an odd number tolerates ${Math.floor(remaining / 2)} failure${Math.floor(remaining / 2) === 1 ? '' : 's'}). ${pick.reason}`,
          downtime: 'none',
          verify: 'docker node ls shows it Reachable.',
          rollback: 'docker node demote.',
        });
      }
    } else if (remaining % 2 === 0) {
      warnings.push(
        `After ${host} leaves there are ${remaining} managers; an even count tolerates no more failures than one fewer.${pick.natSkipped.length ? ` ${pick.reason}` : ''}`,
      );
    }
    demote = {
      id: `manager-demote:${target.nodeId}`,
      kind: 'manager-demote',
      title: `Stop ${host} from being a manager.`,
      detail: `docker node demote${target.swarm?.leader ? ' — it is the raft leader, so leadership moves to another manager first (a few seconds with no swarm changes)' : ''}.`,
      downtime: 'none',
      verify: 'docker node ls shows it as a worker and another manager as Leader.',
      rollback: 'docker node promote.',
    };
  }

  // ── safety backup, capacity, stateless ───────────────────────────────────
  if (online && !input.backupsConfigured && (dataSteps.length > 0 || volumeSteps.length > 0)) {
    warnings.push('No backup destination is set up, so there is no safety copy. Every move still keeps the original on this server until it is verified.');
  }
  const backupStep: DrainStep | undefined =
    online && input.backupsConfigured && needsBackup.size > 0
      ? {
          id: 'safety-backup',
          kind: 'safety-backup',
          volumes: [...needsBackup].sort(),
          title: `Back up ${needsBackup.size} volume${needsBackup.size === 1 ? '' : 's'} first, in case anything goes wrong.`,
          detail: 'restic backup of each volume without a successful snapshot in the last 24 hours, taken on this server (crash-consistent; the nightly logical dumps of managed databases are kept as they are).',
          downtime: 'none',
          verify: 'Each Snapshot row SUCCEEDED with a restic id.',
          rollback: 'Nothing to undo.',
        }
      : undefined;
  const statelessOnTarget = [...new Set(stateless)].sort();
  const schedulableOthers = others.filter(isSchedulable).length;
  for (const s of input.services) {
    if (s.labels[DB_ROLE] === 'replica' && onTarget.has(s.name) && (s.desiredReplicas ?? 0) > 0) {
      // One replica per node, never on the primary's node.
      const primaryNodes = input.services.filter(
        (p) => p.labels[DB_CLUSTER] === s.labels[DB_CLUSTER] && p.labels[DB_ROLE] === 'primary' && p.labels[DB_PIN_NODE_LABEL],
      ).length;
      const slots = schedulableOthers - Math.min(1, primaryNodes);
      if (slots < (s.desiredReplicas ?? 0)) {
        warnings.push(`${s.name} wants ${s.desiredReplicas} replicas but only ${Math.max(0, slots)} server${slots === 1 ? '' : 's'} can hold one after ${host} leaves.`);
      }
    }
  }

  const steps: DrainStep[] = [];
  if (backupStep) steps.push(backupStep);
  if (online) {
    steps.push({
      id: `cordon:${target.nodeId}`,
      kind: 'cordon',
      title: `Stop starting new work on ${host}.`,
      detail: 'docker node update --availability pause: running tasks stay put (so data services keep serving while they move), nothing new is scheduled here.',
      downtime: 'none',
      verify: 'Node availability = pause.',
      rollback: 'Set availability back to active.',
    });
  }
  steps.push(...managerSteps, ...edgeSteps, ...garageSteps, ...dataSteps, ...volumeSteps);
  steps.push({
    id: `drain:${target.nodeId}`,
    kind: 'drain',
    title:
      statelessOnTarget.length > 0
        ? `Move ${statelessOnTarget.length} app${statelessOnTarget.length === 1 ? '' : 's'} with no local data to other servers.`
        : `Empty ${host}.`,
    detail: `docker node update --availability drain: swarm starts each remaining task elsewhere before stopping it here (rolling, per the service's update order).${statelessOnTarget.length ? ` Moves: ${statelessOnTarget.join(', ')}.` : ''}`,
    downtime: 'none',
    verify: 'No task with desired state running remains on the node.',
    rollback: 'Set availability back to active; swarm does not move tasks back on its own.',
  });
  if (garageResync) steps.push(garageResync);
  if (demote) steps.push(demote);
  steps.push({
    id: `swarm-leave:${target.nodeId}`,
    kind: 'swarm-leave',
    title: `Remove ${host} from the swarm.`,
    detail: online
      ? 'The agent runs docker swarm leave on the server, then a manager runs docker node rm. The server\'s disk, volumes included, is left as it is.'
      : 'The server is offline: a manager runs docker node rm --force. If it ever comes back it must be re-enrolled.',
    downtime: 'none',
    verify: 'docker node ls no longer lists it.',
    rollback: 'Re-join it with the install one-liner (it gets a new swarm id).',
  });
  if (target.meshPeer) {
    steps.push({
      id: `mesh-remove:${target.nodeId}`,
      kind: 'mesh-remove',
      title: `Remove ${host} from the private network.`,
      detail: 'Deletes its mesh peer (and setup key) through the active MeshDriver so it can no longer reach the other servers.',
      downtime: 'none',
      verify: 'The mesh peer list no longer contains it.',
      rollback: 'Re-enroll it in the mesh.',
    });
  }
  steps.push({
    id: `forget:${target.nodeId}`,
    kind: 'forget',
    title: `Forget ${host} and revoke its access.`,
    detail: 'Deletes the enrollment row and its session credential; audit rows are kept. Destroy the VM at your provider afterwards — swarmy never deletes a disk.',
    downtime: 'none',
    verify: 'The agent can no longer authenticate.',
    rollback: 'Re-enroll with the install one-liner.',
  });

  const plan: DecommissionPlan = {
    node: header,
    steps,
    blockers,
    warnings: [...new Set(warnings)],
    totals: {
      databases,
      volumes: volumeCount,
      statelessServices: statelessOnTarget.length,
      bytesToMove,
      unknownSizes,
    },
    summary: '',
    runnable: blockers.length === 0,
  };
  plan.summary = summarize(plan);
  return plan;
}

function emptyPlan(node: DecommissionPlan['node'], blockers: Blocker[]): DecommissionPlan {
  const plan: DecommissionPlan = {
    node,
    steps: [],
    blockers,
    warnings: [],
    totals: { databases: 0, volumes: 0, statelessServices: 0, bytesToMove: 0, unknownSizes: 0 },
    summary: '',
    runnable: false,
  };
  plan.summary = summarize(plan);
  return plan;
}

/** The novice sentence. */
export function summarize(plan: DecommissionPlan): string {
  const { hostname } = plan.node;
  if (plan.blockers.length > 0) {
    return `${hostname} can't be retired yet: ${plan.blockers[0]!.message}${plan.blockers.length > 1 ? ` (and ${plan.blockers.length - 1} more)` : ''}`;
  }
  const t = plan.totals;
  const parts: string[] = [];
  if (t.databases) parts.push(`${t.databases} database${t.databases === 1 ? '' : 's'}`);
  if (t.volumes) {
    const size = t.bytesToMove > 0 ? ` (${t.unknownSizes ? 'at least ' : 'about '}${formatBytes(t.bytesToMove)})` : '';
    parts.push(`${t.volumes} volume${t.volumes === 1 ? '' : 's'}${size}`);
  }
  if (t.statelessServices) parts.push(`${t.statelessServices} app${t.statelessServices === 1 ? '' : 's'}`);
  const moves = parts.length ? `moves ${joinWords(parts)} to other servers` : 'has nothing to move';
  const worst = plan.steps.some((s) => s.downtime === 'unknown')
    ? 'Some data comes back from backup, so expect a longer interruption.'
    : plan.steps.some((s) => s.downtime === 'short')
      ? 'Apps with plain volumes pause for about a minute while the last changes copy.'
      : plan.steps.some((s) => s.downtime === 'seconds')
        ? 'Databases pause for a few seconds while they switch over.'
        : 'Nothing stops.';
  return `Retiring ${hostname} ${moves}. ${worst}`;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
