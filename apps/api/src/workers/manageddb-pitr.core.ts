import { createHash } from 'node:crypto';
import {
  DB_AVOID_NODE_LABEL,
  DB_PIN_NODE_LABEL,
  MANAGED_PG_ROOT,
  PG_ENV,
  STACK_LABEL,
  applyPgMember,
  pgBootRole,
} from '@swarmy/core';
import { DEFAULT_WALG_IMAGE, MANAGED_PG_PITR_CONF_TARGET, WAL_ARCHIVE_MOUNT } from '@swarmy/core/protocol';
import { shipperScript } from './manageddb-reconcile.core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';

/**
 * Pure PITR helpers for the manageddb-reconcile worker, focused on keeping
 * point-in-time recovery working ACROSS a failover (QA-068).
 *
 * A failover promotes a replica by flipping labels only (`swarmy.db.role`),
 * so the new writer:
 *   - still runs its replica boot env (`SWARMY_PG_ROLE=replica`, a primary
 *     host pointing at the demoted ex-writer), and
 *   - carries none of the cluster's backup intent: the
 *     `swarmy.db.backup.{schedule,pitr,lastRun,auto}` labels stay on the
 *     demoted ex-primary, where nothing reads them.
 *
 * The worker used to skip replica-env primaries entirely, so WAL archiving
 * and base backups quietly stopped after a failover. These helpers decide
 * what the reconcile does instead. The LIVE role (the label) is the truth,
 * never the boot env. Everything is idempotent, so running it every tick
 * is a no-op at steady state.
 *
 * Colocated as a `.core` module so tests need no gateway/trpc import graph.
 */

// Mirrors of the @swarmy/trpc dbBackup.service / autoBackup label scheme.
export const DB_ROLE_LABEL = 'swarmy.db.role';
export const DB_BACKUP_SCHEDULE_LABEL = 'swarmy.db.backup.schedule';
export const DB_BACKUP_LAST_RUN_LABEL = 'swarmy.db.backup.lastRun';
export const DB_BACKUP_PITR_LABEL = 'swarmy.db.backup.pitr';
export const DB_BACKUP_AUTO_LABEL = 'swarmy.db.backup.auto';
export const DB_PITR_APPLIED_LABEL = 'swarmy.db.pitr.applied';
const DB_PLACED_REGION_LABEL = 'swarmy.db.placedRegion';
const REGION_NODE_LABEL = 'swarmy.region';

/** The cluster's backup intent: it belongs on whichever member is the live primary. */
export const BACKUP_INTENT_LABELS = [
  DB_BACKUP_SCHEDULE_LABEL,
  DB_BACKUP_PITR_LABEL,
  DB_BACKUP_LAST_RUN_LABEL,
  DB_BACKUP_AUTO_LABEL,
] as const;

interface LabelledMember {
  name: string;
  labels: Record<string, string>;
}

export interface BackupIntentCarry {
  /** Labels to add to the live primary. */
  add: Record<string, string>;
  /** Stale labels to drop from the live primary (an auto schedule the user had opted out of). */
  removeFromPrimary: string[];
  /** Members that still hold backup intent: drop it AFTER the primary has it. */
  donors: Array<{ name: string; removeKeys: string[] }>;
}

function isAutoSchedule(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw) as { auto?: unknown };
    return v.auto === true;
  } catch {
    return false;
  }
}

/**
 * A schedule label moved onto a new writer. The `dataVolume` it may name is the
 * OLD writer's PGDATA volume, which is node-local and on another node, so it is
 * dropped. Physical engines then fall back to the new writer's declared
 * `swarmy.db.dataVolume`.
 */
export function rehomeScheduleLabel(raw: string): string {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return raw;
    if (!('dataVolume' in v)) return raw;
    const { dataVolume: _old, ...rest } = v;
    return JSON.stringify(rest);
  } catch {
    return raw;
  }
}

/**
 * PURE: move backup intent from non-primary members onto the live primary.
 * Returns null when there is nothing to do (the steady state).
 *
 * The primary's own labels win, with one exception: an `auto` default schedule
 * that the reconcile's auto-backup loop stamped on the new writer before the
 * carry ran. A user-set schedule on the ex-primary replaces it, and a user
 * opt-out (`auto=off`) removes it.
 */
export function planBackupIntentCarry(
  primary: LabelledMember,
  others: readonly LabelledMember[],
): BackupIntentCarry | null {
  const donors = others
    .filter((m) => m.name !== primary.name)
    .map((m) => ({ m, keys: BACKUP_INTENT_LABELS.filter((k) => m.labels[k] !== undefined) }))
    .filter((d) => d.keys.length > 0);
  if (donors.length === 0) return null;

  const have = { ...primary.labels };
  const add: Record<string, string> = {};
  const removeFromPrimary: string[] = [];
  for (const { m } of donors) {
    const l = m.labels;
    const donorSchedule = l[DB_BACKUP_SCHEDULE_LABEL];
    const primaryAuto = isAutoSchedule(have[DB_BACKUP_SCHEDULE_LABEL]);
    const donorOverridesAuto = primaryAuto && donorSchedule !== undefined && !isAutoSchedule(donorSchedule);
    const donorOptedOut = primaryAuto && l[DB_BACKUP_AUTO_LABEL] === 'off' && donorSchedule === undefined;

    if (donorOptedOut) {
      for (const k of [DB_BACKUP_SCHEDULE_LABEL, DB_BACKUP_PITR_LABEL] as const) {
        if (have[k] !== undefined) {
          removeFromPrimary.push(k);
          delete have[k];
          delete add[k];
        }
      }
    }
    for (const k of BACKUP_INTENT_LABELS) {
      const v = l[k];
      if (v === undefined) continue;
      const scheduleGroup = k === DB_BACKUP_SCHEDULE_LABEL || k === DB_BACKUP_PITR_LABEL;
      if (have[k] !== undefined && !(donorOverridesAuto && scheduleGroup)) continue;
      const value = k === DB_BACKUP_SCHEDULE_LABEL ? rehomeScheduleLabel(v) : v;
      add[k] = value;
      have[k] = value;
    }
    // A user schedule without PITR replacing an auto one must not inherit a stale pitr flag.
    if (donorOverridesAuto && l[DB_BACKUP_PITR_LABEL] === undefined && have[DB_BACKUP_PITR_LABEL] !== undefined) {
      removeFromPrimary.push(DB_BACKUP_PITR_LABEL);
      delete have[DB_BACKUP_PITR_LABEL];
    }
  }
  return {
    add,
    removeFromPrimary: [...new Set(removeFromPrimary)].filter((k) => add[k] === undefined),
    donors: donors.map(({ m, keys }) => ({ name: m.name, removeKeys: [...keys] })),
  };
}

/** Env `KEY=value` strings → a record. */
function envRecord(env: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

export type PitrPrimaryPrep =
  | {
      kind: 'ready';
      /** Labels + env the PITR spec is built from. */
      primary: SwarmServiceInfo;
      /** True when the live primary booted as a replica (a failover promotion). */
      promoted: boolean;
    }
  | { kind: 'wait'; reason: string };

/**
 * PURE: decide from the LIVE role whether (and how) the PITR spec can be
 * applied to the cluster's current primary.
 *
 * A primary deployed as a primary is used as-is. A promoted one (live role
 * primary, boot env replica) is turned into a writer spec first:
 *   - its env becomes a writer's (`SWARMY_PG_ROLE=primary`, no primary host,
 *     port or rejoin epoch). The boot layer keeps the existing PGDATA, since
 *     a writer boot never runs initdb over a non-empty data dir and never
 *     removes data;
 *   - it is PINNED to the node it runs on now, and its replica anti-affinity
 *     is dropped. Its data volume is node-local, so the redeploy must land
 *     on the same node, or it would come up on an empty volume.
 *
 * `runningOnSwarmNode` is the swarm node id of the member's running task.
 * Without a pin or a running task there is no safe node yet, so the caller
 * waits a tick. A multi-task service is never redeployed: its tasks would
 * share one writer spec.
 */
export function preparePitrPrimary(
  primary: SwarmServiceInfo,
  runningOnSwarmNode: string | undefined,
): PitrPrimaryPrep {
  const env = envRecord(primary.env ?? []);
  if (pgBootRole(env) === 'primary') return { kind: 'ready', primary, promoted: false };

  if ((primary.desiredReplicas ?? 1) > 1) {
    return { kind: 'wait', reason: `${primary.name} runs ${primary.desiredReplicas} tasks; a writer must run one` };
  }
  const pin = primary.labels[DB_PIN_NODE_LABEL] ?? runningOnSwarmNode;
  if (!pin) return { kind: 'wait', reason: `${primary.name} has no running task to pin its data volume to` };

  const labels: Record<string, string> = { ...primary.labels, [DB_PIN_NODE_LABEL]: pin };
  delete labels[DB_AVOID_NODE_LABEL];
  const writerEnv: Record<string, string> = { ...env, [PG_ENV.role]: 'primary' };
  delete writerEnv[PG_ENV.primaryHost];
  delete writerEnv[PG_ENV.primaryPort];
  delete writerEnv[PG_ENV.rejoin];
  return {
    kind: 'ready',
    promoted: true,
    primary: {
      ...primary,
      labels,
      env: Object.entries(writerEnv).map(([k, v]) => `${k}=${v}`),
    },
  };
}

/**
 * PURE: the PITR-enabled primary spec: archive volume, extended conf, marker.
 * Built from live truth (or a {@link preparePitrPrimary} result), so it is the
 * same spec whichever member currently holds the primary role.
 */
export function pitrPrimarySpec(
  primary: SwarmServiceInfo,
  c: { base: string },
  net: string,
  version: string,
  dataVolume: string | undefined,
): ServiceSpec {
  const networks = (primary.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  const placedRegion = primary.labels[DB_PLACED_REGION_LABEL];
  const confName = `${c.base}-pitr-conf`;
  const labels = { ...primary.labels, [DB_PITR_APPLIED_LABEL]: version };
  // The declared storage volume (applyPgMember below) wins the data root.
  return applyPgMember<ServiceSpec>({
    name: primary.name,
    image: primary.image,
    mode: { replicated: { replicas: primary.desiredReplicas ?? 1 } },
    env: envRecord(primary.env ?? []),
    labels,
    networks: networks.length > 0 ? networks : [net],
    mounts: [
      { type: 'volume' as const, source: `${c.base}-wal-archive`, target: WAL_ARCHIVE_MOUNT },
      // Physical base backups (wal-g backup-push) need the PGDATA on a named
      // volume; mount it at the data root when the schedule names one.
      ...(dataVolume
        ? [{ type: 'volume' as const, source: dataVolume, target: MANAGED_PG_ROOT }]
        : []),
    ],
    configs: [
      ...(primary.configs ?? []).filter((n) => n !== confName).map((n) => ({ source: n })),
      { source: confName, target: MANAGED_PG_PITR_CONF_TARGET },
    ],
    ...((primary.secrets ?? []).length > 0
      ? { secrets: (primary.secrets ?? []).map((n) => ({ source: n })) }
      : {}),
    ...(placedRegion
      ? { placement: { constraints: [`node.labels.${REGION_NODE_LABEL}==${placedRegion}`] } }
      : {}),
  }, labels);
}

// ── wal-shipper sidecar ───────────────────────────────────────────────────────

const MANAGED_LABEL = 'swarmy.managed';
const DB_CLUSTER_LABEL = 'swarmy.db.cluster';
const DB_WAL_SHIPPER_LABEL = 'swarmy.db.walShipper';
const SCALE_TO_ZERO_EXEMPT_LABEL = 'swarmy.scaleToZero.exempt';
/**
 * Revision of the shipper's own spec (loop script + networks). The PITR
 * version only covers creds + data volume, so a change to the shipper itself,
 * such as the QA-080 fix or joining the storage network, would otherwise never
 * reach a running shipper.
 */
export const DB_WAL_SHIPPER_REV_LABEL = 'swarmy.db.walShipper.rev';

/** PURE: the shipper revision for this script and these networks. */
export function walShipperRev(networks: readonly string[]): string {
  return createHash('sha256')
    .update(shipperScript())
    .update('\n')
    .update([...networks].sort().join(','))
    .digest('hex')
    .slice(0, 10);
}

/** Networks the shipper joins: the cluster net and the storage overlay (in-cluster S3), QA-080. */
export function walShipperNetworks(clusterNet: string, storageNetwork: string | undefined): string[] {
  return storageNetwork && storageNetwork !== clusterNet ? [clusterNet, storageNetwork] : [clusterNet];
}

/** PURE: is the running shipper already this version AND this revision? */
export function walShipperUpToDate(
  shipper: { labels: Record<string, string> } | undefined,
  version: string,
  networks: readonly string[],
): boolean {
  return (
    shipper?.labels[DB_PITR_APPLIED_LABEL] === version &&
    shipper.labels[DB_WAL_SHIPPER_REV_LABEL] === walShipperRev(networks)
  );
}

/** PURE: the per-cluster wal-shipper sidecar (wal-g loop, creds via Docker secret). */
export function walShipperSpec(
  c: { base: string; stack: string; cluster: string },
  version: string,
  secretName: string,
  primary: { labels: Record<string, string> },
  networks: readonly string[],
): ServiceSpec {
  const placedRegion = primary.labels[DB_PLACED_REGION_LABEL];
  // The archive volume is node-local: follow the primary's node pin exactly.
  const pin = primary.labels[DB_PIN_NODE_LABEL];
  const constraints = [
    ...(placedRegion ? [`node.labels.${REGION_NODE_LABEL}==${placedRegion}`] : []),
    ...(pin ? [`node.id==${pin}`] : []),
  ];
  return {
    name: `${c.base}-wal-shipper`,
    image: DEFAULT_WALG_IMAGE,
    mode: { replicated: { replicas: 1 } },
    command: ['/bin/sh', '-c', shipperScript()],
    labels: {
      [MANAGED_LABEL]: 'true',
      [STACK_LABEL]: c.stack,
      [DB_CLUSTER_LABEL]: c.cluster,
      [DB_WAL_SHIPPER_LABEL]: 'true',
      [DB_PITR_APPLIED_LABEL]: version,
      [DB_WAL_SHIPPER_REV_LABEL]: walShipperRev(networks),
      [SCALE_TO_ZERO_EXEMPT_LABEL]: 'true',
    },
    mounts: [{ type: 'volume' as const, source: `${c.base}-wal-archive`, target: WAL_ARCHIVE_MOUNT }],
    secrets: [{ source: secretName, target: 'wal-creds' }],
    networks: [...networks],
    ...(constraints.length > 0 ? { placement: { constraints } } : {}),
  };
}
