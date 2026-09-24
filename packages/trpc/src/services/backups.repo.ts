/**
 * Backup/DR config repositories — swarm-kv (P4 slice 3).
 *
 * Where backups go, when they run and the controller self-backup settings are
 * desired config the DR path needs BEFORE the controller store exists: after
 * this slice a controller that lost its volume (and has no Garage replica)
 * still knows where its backups are, because every manager's raft holds them.
 *
 *  - `bkp-target/<id>`   BackupTarget (credentials stay vault `*Ref` blobs)
 *  - `bkp-sched/<id>`    BackupSchedule (run times derive from BackupJob)
 *  - `mirror/<orgId>`    OffsiteMirror (one per org)
 *  - `ctl-backup/controller` ControllerBackupConfig, in the org that owns its
 *    target (the controller's own swarm); readers scan reachable orgs.
 *
 * History (Snapshot, BackupJob, ControllerSnapshot, OffsiteMirrorRun) stays in
 * the controller store; its `targetId` / `scheduleId` / `mirrorId` are plain
 * strings now, and deletes cascade in the services.
 */
import { kvTable, reachableOrgIds, type KvRow, type KvScope } from './kv-repo';
import { kvFor } from './swarm-kv.service';
import type { DB } from '@swarmy/db';
import type { AgentHub } from '../hub/types';

export interface BackupTargetDoc {
  name: string;
  /** 'S3' | 'NODE' */
  kind: string;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  credentialRef: string | null;
  secretKeyRef: string | null;
  resticPasswordRef: string;
  enabled: boolean;
}
export type BackupTargetRow = KvRow<BackupTargetDoc>;

export const backupTargets = kvTable<BackupTargetDoc>('bkp-target', {
  defaults: () => ({ kind: 'S3', enabled: true, endpoint: null, prefix: null, region: null, credentialRef: null, secretKeyRef: null }),
  unique: [['name']],
});

export interface BackupScheduleDoc {
  targetId: string;
  /** Optional second destination: every run also copies the volume here (off-site copy). */
  secondaryTargetId: string | null;
  volume: string;
  nodeId: string | null;
  every: number;
  unit: string;
  paused: boolean;
  auto: boolean;
  retentionDays: number | null;
  /** Interval anchor (desired config, not run state). */
  anchorAt: Date | null;
  /** Opt-out tombstone of a removed auto schedule. */
  optedOutAt: Date | null;
}

export const backupSchedules = kvTable<BackupScheduleDoc>('bkp-sched', {
  dateFields: ['anchorAt', 'optedOutAt'],
  defaults: () => ({ secondaryTargetId: null, nodeId: null, paused: false, auto: false, retentionDays: null, anchorAt: null, optedOutAt: null }),
});

export interface OffsiteMirrorDoc {
  targetId: string;
  allBuckets: boolean;
  buckets: string[];
  prefix: string;
  everyMinutes: number;
  /** "copy" | "sync" */
  mode: string;
  graceDays: number;
  enabled: boolean;
  sourceAccessKeyRef: string | null;
  sourceSecretKeyRef: string | null;
}

/** One mirror per org: the row id IS the org id. */
export const offsiteMirrors = kvTable<OffsiteMirrorDoc>('mirror', {
  defaults: () => ({
    allBuckets: true,
    buckets: [],
    prefix: 'swarmy-mirror',
    everyMinutes: 60,
    mode: 'copy',
    graceDays: 7,
    enabled: true,
    sourceAccessKeyRef: null,
    sourceSecretKeyRef: null,
  }),
});

/** Every org's rows of a table, for cross-org workers (unreachable orgs skipped). */
export async function allOrgRows<R>(
  scope: { db: DB; hub: AgentHub },
  table: (s: KvScope, orgId: string) => { findMany(a?: object): Promise<R[]> },
  args?: object,
): Promise<R[]> {
  const out: R[] = [];
  for (const orgId of await reachableOrgIds(scope)) {
    out.push(...(await table(scope, orgId).findMany(args).catch(() => [] as R[])));
  }
  return out;
}

// ── ControllerBackupConfig ────────────────────────────────────────────────────

export interface ControllerBackupConfigDoc {
  targetId: string | null;
  enabled: boolean;
  schedule: string;
  retention: { keepDaily: number; keepWeekly: number; keepMonthly: number };
  restorePassphraseRef: string | null;
  restorePassphraseHint: string | null;
}
export type ControllerBackupConfigRow = ControllerBackupConfigDoc & {
  id: string;
  /** The org whose swarm holds the document (null = not stored yet). */
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const CONTROLLER_BACKUP_ID = 'controller';

/**
 * The controller self-backup settings. `homeOrgId` is where a new document is
 * written (the org whose admin configures it); reads find an existing one in
 * any reachable org first.
 */
export const controllerBackupConfigRepo = {
  async find(scope: { db: DB; hub: AgentHub }, preferOrgId?: string | null): Promise<ControllerBackupConfigRow | null> {
    const orgs = await reachableOrgIds(scope).catch(() => [] as string[]);
    const ordered = preferOrgId ? [preferOrgId, ...orgs.filter((o) => o !== preferOrgId)] : orgs;
    for (const orgId of ordered) {
      const doc = await kvFor(scope, orgId)
        .getDoc<ControllerBackupConfigDoc & { createdAt?: string }>('ctl-backup', CONTROLLER_BACKUP_ID)
        .catch(() => null);
      if (doc) {
        const { createdAt, ...value } = doc.value;
        const updatedAt = new Date(doc.updatedAt || Date.now());
        return { ...value, id: CONTROLLER_BACKUP_ID, orgId, createdAt: createdAt ? new Date(createdAt) : updatedAt, updatedAt };
      }
    }
    return null;
  },
  async write(
    scope: { db: DB; hub: AgentHub },
    orgId: string,
    value: ControllerBackupConfigDoc,
  ): Promise<ControllerBackupConfigRow> {
    const doc = await kvFor(scope, orgId).put('ctl-backup', CONTROLLER_BACKUP_ID, value);
    const updatedAt = new Date(doc.updatedAt || Date.now());
    return { ...value, id: CONTROLLER_BACKUP_ID, orgId, createdAt: updatedAt, updatedAt };
  },
};
