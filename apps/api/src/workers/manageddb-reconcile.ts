import { STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';

/**
 * Managed DB HA-topology reconcile worker (epic #8).
 *
 * Every ~15s, for each org, read the managed-DB clusters off the LIVE inventory
 * (services carrying `swarmy.db.engine` + `swarmy.db.cluster`) and CONVERGE each
 * cluster's live member set to its declared HA topology (`swarmy.db.topology`).
 * Pure Docker-truth: reads the hub snapshot, dispatches to the org's manager, no
 * DB. Topology is changeable IN-SITU — flip the label (via the manageddb router)
 * and this loop stands up / tears down infra to match on the next tick.
 *
 *   single          → one writer, replica service parked at 0.
 *   primary-replica → 1 writer + N async read replicas (the existing behaviour;
 *                     missing topology label defaults here, so legacy clusters are
 *                     untouched).
 *   failover        → primary-replica + a single-node etcd consensus member
 *                     (`-dcs`) as the election substrate, and the observed leader
 *                     reflected back as `swarmy.db.leader`. The actual promotion
 *                     (`pg_ctl promote` + role flip) is a documented hook below —
 *                     swarmy deploys the DCS + observes; it does not arbitrate
 *                     election in this loop (no split-brain decisions without
 *                     real quorum). A Patroni/Stolon image would run Postgres
 *                     against this same etcd member.
 *   geo             → write-region primary (pinned to `swarmy.region==<region>`)
 *                     + per-region read-replica siblings materialised from
 *                     `swarmy.db.region.<region>.replicas` (the exact per-region
 *                     placement-constraint model region-reconcile.ts uses).
 *   active-active   → `swarmy.db.primaries` writable primaries. swarmy
 *                     materialises the members; the bidirectional logical-
 *                     replication pub/sub + conflict policy are engine concerns
 *                     (last-writer-wins by default — see caveat below).
 *
 * The label scheme is mirrored from `@swarmy/trpc` manageddb.service.ts — a
 * worker cannot subpath-import an internal trpc module (same constraint the
 * region/geodns reconcile workers document), so the constants are inlined and
 * kept in sync.
 */

const TICK_MS = 15_000;

// ── Label scheme — kept in sync with @swarmy/trpc manageddb.service.ts. ──
const DB_ENGINE_LABEL = 'swarmy.db.engine';
const DB_ROLE_LABEL = 'swarmy.db.role';
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const DB_REPLICAS_LABEL = 'swarmy.db.replicas';
const DB_TOPOLOGY_LABEL = 'swarmy.db.topology';
const DB_WRITE_REGION_LABEL = 'swarmy.db.writeRegion';
const DB_PLACED_REGION_LABEL = 'swarmy.db.placedRegion';
const DB_REGION_LABEL = 'swarmy.db.region';
const DB_PRIMARIES_LABEL = 'swarmy.db.primaries';
const DB_MEMBER_LABEL = 'swarmy.db.member';
const DB_LEADER_LABEL = 'swarmy.db.leader';
const MANAGED_LABEL = 'swarmy.managed';
const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';
const REGION_NODE_LABEL = 'swarmy.region';
const DB_REGION_REPLICAS_RE = /^swarmy\.db\.region\.(.+)\.replicas$/;

const PG_PORT = 5432;
const REPLICATION_USER = 'repl';
const DEFAULT_DATABASE = 'app';
/** Election substrate for `failover` — a Patroni/Stolon image talks to this. */
const ETCD_IMAGE = 'bitnami/etcd:3';

type DbTopology = 'single' | 'primary-replica' | 'failover' | 'geo' | 'active-active';
const TOPOLOGIES: readonly string[] = [
  'single',
  'primary-replica',
  'failover',
  'geo',
  'active-active',
];
const DEFAULT_TOPOLOGY: DbTopology = 'primary-replica';

/** Env `KEY=value` strings → a spec env record. */
function envRecord(env: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

function topologyOf(labels: Record<string, string> | undefined): DbTopology {
  const v = labels?.[DB_TOPOLOGY_LABEL];
  return v && TOPOLOGIES.includes(v) ? (v as DbTopology) : DEFAULT_TOPOLOGY;
}

function parseRegionReplicas(labels: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(labels)) {
    const m = DB_REGION_REPLICAS_RE.exec(key);
    if (!m) continue;
    const region = m[1];
    const n = Number.parseInt(value, 10);
    if (!region || Number.isNaN(n) || n < 0) continue;
    out.set(region, n);
  }
  return out;
}

interface Cluster {
  stack: string;
  cluster: string;
  /** `<stack>_<cluster>` — sibling service names derive from this. */
  base: string;
  primary?: SwarmServiceInfo;
  /** Base (unregioned) read-replica service. */
  replica?: SwarmServiceInfo;
  /** failover consensus member. */
  dcs?: SwarmServiceInfo;
  /** active-active: index (>=2) → extra primary service. */
  extraPrimaries: Map<number, SwarmServiceInfo>;
  /** geo: region → region-pinned replica sibling. */
  regionReplicas: Map<string, SwarmServiceInfo>;
}

/** Common labels every materialised DB member carries (kept warm, Docker-truth). */
function memberLabels(
  cluster: Cluster,
  role: 'primary' | 'replica' | 'dcs',
  topology: DbTopology,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    [MANAGED_LABEL]: 'true',
    [STACK_LABEL]: cluster.stack,
    [DB_ENGINE_LABEL]: 'postgres',
    [DB_CLUSTER_LABEL]: cluster.cluster,
    [DB_ROLE_LABEL]: role,
    [DB_TOPOLOGY_LABEL]: topology,
    [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
    ...extra,
  };
}

const clusterNet = (c: Cluster) => `${c.base}-net`;

/** etcd DCS member — the consensus store a Patroni-style supervisor would use. */
function dcsSpec(c: Cluster): ServiceSpec {
  const name = `${c.base}-dcs`;
  return {
    name,
    image: ETCD_IMAGE,
    mode: { replicated: { replicas: 1 } },
    env: {
      ALLOW_NONE_AUTHENTICATION: 'yes',
      ETCD_LISTEN_CLIENT_URLS: 'http://0.0.0.0:2379',
      ETCD_ADVERTISE_CLIENT_URLS: `http://${name}:2379`,
    },
    labels: memberLabels(c, 'dcs', 'failover'),
    networks: [clusterNet(c)],
  };
}

/** A region-pinned streaming read replica (geo). Mirrors region-reconcile placement. */
function regionReplicaSpec(c: Cluster, primary: SwarmServiceInfo, region: string, n: number): ServiceSpec {
  const env = envRecord(primary.env ?? []);
  const password = env.POSTGRESQL_PASSWORD ?? '';
  return {
    name: `${c.base}-replica-${region}`,
    image: primary.image,
    mode: { replicated: { replicas: n } },
    env: {
      POSTGRESQL_REPLICATION_MODE: 'slave',
      POSTGRESQL_REPLICATION_USER: env.POSTGRESQL_REPLICATION_USER ?? REPLICATION_USER,
      POSTGRESQL_REPLICATION_PASSWORD: env.POSTGRESQL_REPLICATION_PASSWORD ?? password,
      POSTGRESQL_MASTER_HOST: primary.name,
      POSTGRESQL_MASTER_PORT_NUMBER: String(PG_PORT),
      POSTGRESQL_PASSWORD: password,
    },
    labels: memberLabels(c, 'replica', 'geo', {
      [DB_REGION_LABEL]: region,
      [DB_REPLICAS_LABEL]: String(n),
    }),
    networks: [clusterNet(c)],
    placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] },
  };
}

/** An additional writable primary (active-active). */
function extraPrimarySpec(c: Cluster, primary: SwarmServiceInfo, index: number): ServiceSpec {
  const env = envRecord(primary.env ?? []);
  return {
    name: `${c.base}-primary-${index}`,
    image: primary.image,
    mode: { replicated: { replicas: 1 } },
    env: {
      POSTGRESQL_REPLICATION_MODE: 'master',
      POSTGRESQL_REPLICATION_USER: env.POSTGRESQL_REPLICATION_USER ?? REPLICATION_USER,
      POSTGRESQL_REPLICATION_PASSWORD: env.POSTGRESQL_REPLICATION_PASSWORD ?? env.POSTGRESQL_PASSWORD ?? '',
      POSTGRESQL_PASSWORD: env.POSTGRESQL_PASSWORD ?? '',
      POSTGRESQL_DATABASE: env.POSTGRESQL_DATABASE ?? DEFAULT_DATABASE,
    },
    labels: memberLabels(c, 'primary', 'active-active', { [DB_MEMBER_LABEL]: String(index) }),
    networks: [clusterNet(c)],
  };
}

/**
 * Re-place the primary onto a node in `region` (geo). Rebuilt from live truth
 * (image + env + networks + labels) with a region-pinning placement constraint,
 * and stamps `swarmy.db.placedRegion` so this is a one-shot per write-region
 * change (steady state diffs equal → no redeploy). Same lossy-merge caveat as
 * manageddb.service.ts#injectConnection: mounts/configs/secrets/healthcheck are
 * not surfaced by the live inventory and are not re-applied here.
 */
function placePrimarySpec(primary: SwarmServiceInfo, region: string, net: string): ServiceSpec {
  const networks = (primary.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  return {
    name: primary.name,
    image: primary.image,
    mode: { replicated: { replicas: primary.desiredReplicas ?? 1 } },
    env: envRecord(primary.env ?? []),
    labels: { ...primary.labels, [DB_PLACED_REGION_LABEL]: region },
    networks: networks.length > 0 ? networks : [net],
    placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${region}`] },
  };
}

async function reconcileOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;

  const { services } = hub.liveInventory(orgId);

  // Index every managed-DB service into its cluster, keyed by (stack, cluster).
  const clusters = new Map<string, Cluster>();
  for (const s of services) {
    if (s.labels[DB_ENGINE_LABEL] !== 'postgres') continue;
    const cluster = s.labels[DB_CLUSTER_LABEL];
    if (!cluster) continue;
    const stack = s.labels[STACK_LABEL] ?? '';
    const key = `${stack} ${cluster}`;
    const c =
      clusters.get(key) ??
      ({
        stack,
        cluster,
        base: `${stack}_${cluster}`,
        extraPrimaries: new Map(),
        regionReplicas: new Map(),
      } as Cluster);

    const role = s.labels[DB_ROLE_LABEL];
    const region = s.labels[DB_REGION_LABEL];
    const member = Number.parseInt(s.labels[DB_MEMBER_LABEL] ?? '', 10);
    if (role === 'dcs') {
      c.dcs = s;
    } else if (role === 'primary') {
      if (Number.isFinite(member) && member >= 2) c.extraPrimaries.set(member, s);
      else c.primary = s;
    } else if (role === 'replica') {
      if (region) c.regionReplicas.set(region, s);
      else c.replica = s;
    }
    clusters.set(key, c);
  }

  // Dispatch helpers (best-effort; a failed tick simply retries next interval).
  const deploy = (spec: ServiceSpec) =>
    hub.dispatch(node, 'service.deploy', { spec, pullPolicy: 'always' }).catch(() => undefined);
  const scale = (service: string, replicas: number) =>
    hub.dispatch(node, 'service.scale', { service, replicas }).catch(() => undefined);
  const remove = (service: string) =>
    hub.dispatch(node, 'service.remove', { service }).catch(() => undefined);
  const setLabels = (service: string, add: Record<string, string>) =>
    hub.dispatch(node, 'service.updateLabels', { service, add, removeKeys: [] }).catch(() => undefined);
  const ensureNet = (c: Cluster) =>
    hub
      .dispatch(node, 'network.ensure', {
        name: clusterNet(c),
        driver: 'overlay',
        attachable: true,
        labels: { [MANAGED_LABEL]: 'true', [DB_CLUSTER_LABEL]: c.cluster },
      })
      .catch(() => undefined);

  for (const c of clusters.values()) {
    const primary = c.primary;
    const topology = topologyOf(primary?.labels ?? c.replica?.labels);
    const declaredRaw = Number.parseInt(
      primary?.labels[DB_REPLICAS_LABEL] ?? c.replica?.labels[DB_REPLICAS_LABEL] ?? '0',
      10,
    );
    const declared = Number.isNaN(declaredRaw) || declaredRaw < 0 ? 0 : declaredRaw;

    // (1) Base read-replica count. geo carries reads on region siblings, and
    //     single has no replicas — both park the base replica at 0.
    if (c.replica) {
      const target = topology === 'single' || topology === 'geo' ? 0 : declared;
      if ((c.replica.desiredReplicas ?? 0) !== target) await scale(c.replica.name, target);
    }

    // (2) failover — etcd consensus member + leader observation.
    if (topology === 'failover') {
      if (!c.dcs) {
        await ensureNet(c);
        await deploy(dcsSpec(c));
      }
      if (primary) {
        const healthy = (primary.runningReplicas ?? 0) > 0;
        const want = healthy ? primary.name : (primary.labels[DB_LEADER_LABEL] ?? '');
        if (want && primary.labels[DB_LEADER_LABEL] !== want) {
          await setLabels(primary.name, { [DB_LEADER_LABEL]: want });
        }
        // PROMOTION HOOK (documented, not arbitrated here): when `!healthy` and a
        // replica is running, a Patroni/Stolon supervisor — running Postgres
        // against the etcd `-dcs` member above — elects and `pg_ctl promote`s a
        // replica, flips its `swarmy.db.role` to primary, and re-points followers.
        // swarmy stamps `swarmy.db.leader` to REFLECT the outcome; it does not
        // decide elections in this loop (avoids split-brain without real quorum).
        // See plans/managed-db-topology.md "Failover / promotion sketch".
      }
    } else if (c.dcs) {
      // Topology moved away from failover → tear the consensus member down.
      await remove(c.dcs.name);
    }

    // (3) geo — write-region primary + per-region read replicas.
    if (topology === 'geo') {
      await ensureNet(c);
      const writeRegion = primary?.labels[DB_WRITE_REGION_LABEL];
      if (primary && writeRegion && primary.labels[DB_PLACED_REGION_LABEL] !== writeRegion) {
        await deploy(placePrimarySpec(primary, writeRegion, clusterNet(c)));
      }
      const wanted = primary ? parseRegionReplicas(primary.labels) : new Map<string, number>();
      // Create missing / scale drifted region siblings.
      for (const [region, n] of wanted) {
        const sib = c.regionReplicas.get(region);
        if (n <= 0) {
          if (sib) await remove(sib.name);
          continue;
        }
        if (!sib) {
          if (primary) await deploy(regionReplicaSpec(c, primary, region, n));
        } else if ((sib.desiredReplicas ?? 0) !== n) {
          await scale(sib.name, n);
        }
      }
      // Remove region siblings no longer declared.
      for (const [region, sib] of c.regionReplicas) {
        if (!wanted.has(region) || (wanted.get(region) ?? 0) <= 0) await remove(sib.name);
      }
    } else {
      // Not geo → remove any region siblings left over from a prior geo topology.
      for (const sib of c.regionReplicas.values()) await remove(sib.name);
    }

    // (4) active-active — N writable primaries.
    if (topology === 'active-active') {
      await ensureNet(c);
      const wantPrimaries = Math.max(
        2,
        Number.parseInt(primary?.labels[DB_PRIMARIES_LABEL] ?? '2', 10) || 2,
      );
      if (primary) {
        for (let i = 2; i <= wantPrimaries; i++) {
          if (!c.extraPrimaries.has(i)) await deploy(extraPrimarySpec(c, primary, i));
        }
      }
      for (const [i, ex] of c.extraPrimaries) {
        if (i > wantPrimaries) await remove(ex.name);
      }
      // CONFLICT CAVEAT (documented): active-active = N writable primaries wired
      // for bidirectional logical replication. swarmy materialises the members;
      // the pub/sub wiring (CREATE PUBLICATION/SUBSCRIPTION between every pair)
      // and conflict resolution are engine concerns — last-writer-wins by
      // default, so apps must avoid cross-primary write contention (sharded /
      // unique-id writes). swarmy does NOT auto-resolve write conflicts.
    } else {
      for (const ex of c.extraPrimaries.values()) await remove(ex.name);
    }

    // Stamp the leader on a single-writer-with-replicas cluster too, so the canvas
    // always has a writer to point at (the primary is the leader by definition).
    if (
      topology !== 'failover' &&
      topology !== 'active-active' &&
      primary &&
      (primary.runningReplicas ?? 0) > 0 &&
      primary.labels[DB_LEADER_LABEL] !== primary.name
    ) {
      await setLabels(primary.name, { [DB_LEADER_LABEL]: primary.name });
    }
  }
}

export function startManagedDbReconcile(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void reconcileOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
