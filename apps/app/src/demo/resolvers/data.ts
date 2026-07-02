import type { DemoStore, DomainResolvers } from '../types';

/**
 * Data + DR demo resolvers — the Backups page, the Schedules / DR page, the
 * controller-state backup settings, and the replicated object store. Covers the
 * `backups`, `schedules`, `controllerBackup`, and `storage` routers.
 *
 * Everything lives under `store.extra.data`; mutations push/flip rows so the
 * pages reflect changes after they invalidate and re-read. Demo mode has no real
 * vault — we track "configured" flags (hasCredentials / hasPassphrase /
 * hasAccessKeys) exactly the way the real views do (the views never return the
 * secrets themselves), and fabricate plausible restic ids / fingerprints.
 *
 * Return shapes mirror the controller service view types exactly:
 *  - BackupTargetView / SnapshotView          (backups.service.ts)
 *  - BackupScheduleView / RestoreOperationView (backupSchedule.service.ts)
 *  - ControllerBackupConfigView / ControllerSnapshotView (controllerBackup.service.ts)
 *  - StorageClusterView / StorageStatusView   (replicatedStore.service.ts)
 */

// ── view types (structural mirrors of the controller service views) ──────────

type BackupTargetKind = 's3' | 'node';

interface BackupTargetView {
  id: string;
  name: string;
  kind: BackupTargetKind;
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  hasCredentials: boolean;
  enabled: boolean;
  createdAt: string;
}

interface SnapshotView {
  id: string;
  volume: string;
  targetId: string;
  targetName: string;
  status: string;
  resticId: string | null;
  sizeBytes: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

type IntervalUnit = 'minutes' | 'hours' | 'days';

interface BackupScheduleView {
  id: string;
  targetId: string;
  volume: string;
  nodeId: string | null;
  every: number;
  unit: IntervalUnit;
  paused: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

interface RestoreOperationView {
  id: string;
  snapshotId: string;
  targetVolume: string;
  targetNodeId: string | null;
  status: string;
  reason: string;
  bytesRestored: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface ControllerRetention {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

interface ControllerBackupConfigView {
  enabled: boolean;
  targetId: string | null;
  schedule: string;
  retention: ControllerRetention;
  hasPassphrase: boolean;
  passphraseHint: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

/** Mirror of ControllerManifest (controllerBackup.bundle.ts). */
interface ControllerManifest {
  swarmyVersion: string;
  schemaVersion: string;
  dbDriver: 'pglite' | 'postgres';
  createdAt: string;
  orgCount: number;
  nodeCount: number;
  includedTables: 'control-plane' | 'all';
}

interface ControllerSnapshotView {
  id: string;
  targetId: string;
  resticSnapshotId: string | null;
  sizeBytes: string | null;
  durationMs: number | null;
  status: string;
  manifest: ControllerManifest | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface StorageClusterView {
  enabled: boolean;
  driver: 'garage' | 'minio' | 'none';
  replicationFactor: number;
  region: string;
  memberNodeIds: string[];
  endpoint: string | null;
  hasAccessKeys: boolean;
  updatedAt: string | null;
}

interface StorageStatusView {
  enabled: boolean;
  driver: string;
  members: { nodeId: string; online: boolean }[];
  endpoint: string | null;
}

// ── DB backups (slice A1) — mirrors of the @swarmy/core views ────────────────

type DbBackupEngine = 'pg_dump' | 'pg_dumpall' | 'snapshot-from-replica' | 'wal-g' | 'pgbackrest';
type DbBackupRunStatus = 'succeeded' | 'failed';

interface DbBackupScheduleView {
  stack: string;
  cluster: string;
  cron: string;
  engine: DbBackupEngine;
  retentionDays: number;
  pitr: boolean;
  targetId: string | null;
  dataVolume: string | null;
  lastRunAt: string | null;
  lastStatus: DbBackupRunStatus | null;
  nextRunAt: string | null;
}

interface DbBackupSnapshotView {
  id: string;
  time: string;
  engine: DbBackupEngine | null;
  sizeBytes: string | null;
  tags: string[];
}

interface DbBackupOverviewRow {
  stack: string;
  cluster: string;
  scheduled: boolean;
  cron: string | null;
  engine: DbBackupEngine | null;
  retentionDays: number | null;
  pitr: boolean;
  targetId: string | null;
  targetName: string | null;
  lastBackupAt: string | null;
  lastStatus: DbBackupRunStatus | null;
  lastSizeBytes: string | null;
  nextRunAt: string | null;
  pitrWindow: { from: string; to: string } | null;
}

// ── demo world ───────────────────────────────────────────────────────────────

interface StorageState {
  enabled: boolean;
  driver: 'garage' | 'none';
  replicationFactor: number;
  region: string;
  memberNodeIds: string[];
  hasAccessKeys: boolean;
  updatedAt: string | null;
}

interface ControllerBackupState {
  enabled: boolean;
  targetId: string | null;
  schedule: string;
  retention: ControllerRetention;
  hasPassphrase: boolean;
  passphraseHint: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  snapshots: ControllerSnapshotView[];
}

interface DbBackupSchedule {
  cron: string;
  engine: DbBackupEngine;
  retentionDays: number;
  pitr: boolean;
  targetId: string | null;
  dataVolume: string | null;
}

interface DbClusterState {
  stack: string;
  cluster: string;
  schedule: DbBackupSchedule | null;
  lastRunAt: string | null;
  lastStatus: DbBackupRunStatus | null;
  lastSizeBytes: string | null;
}

interface DbSnapshotState extends DbBackupSnapshotView {
  stack: string;
  cluster: string;
}

// ── Managed-DB topology (slice A2) — mirrors manageddb.service view shapes ────

type DbMemberStatus = 'running' | 'degraded' | 'deploying' | 'idle' | 'stopped' | 'absent';

interface DbTopoMember {
  service: string;
  role: 'primary' | 'replica' | 'dcs';
  region?: string;
  status: DbMemberStatus;
  desired: number;
  running: number;
  lagSeconds?: number;
}

/** Seed state for one cluster's live topology (`db.get`). */
interface DbTopoState {
  stack: string;
  cluster: string;
  topology: 'single' | 'primary-replica' | 'failover' | 'geo' | 'active-active';
  members: DbTopoMember[];
  leader?: string;
}

interface DataState {
  targets: BackupTargetView[];
  snapshots: SnapshotView[];
  schedules: BackupScheduleView[];
  restores: RestoreOperationView[];
  controller: ControllerBackupState;
  storage: StorageState;
  dbClusters: DbClusterState[];
  dbSnapshots: DbSnapshotState[];
  /** slice A2: live-topology seeds behind `db.get` (lag badges, leader crown). */
  dbTopologies: DbTopoState[];
}

const GARAGE_S3_PORT = 3900;
const GARAGE_SERVICE = 'swarmy-garage';
const DEFAULT_RETENTION: ControllerRetention = { keepDaily: 7, keepWeekly: 4, keepMonthly: 3 };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function nowIso(): string {
  return new Date().toISOString();
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Restic snapshot ids are 8-hex prefixes of a sha256 — fake one that looks real. */
function resticId(): string {
  return Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

/** A 12-char hex fingerprint, matching passphraseFingerprint()'s shape. */
function fingerprint(): string {
  return Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

/** A four-word card-friendly passphrase, matching generateRestorePassphrase()'s vibe. */
function passphrase(): string {
  const words = [
    'amber', 'beacon', 'cobalt', 'driftwood', 'ember', 'fathom', 'granite', 'harbor',
    'ivory', 'juniper', 'kestrel', 'lantern', 'meadow', 'nimbus', 'opal', 'pioneer',
    'quarry', 'ridge', 'summit', 'tundra', 'umber', 'vortex', 'willow', 'zephyr',
  ];
  const pick = (): string => words[Math.floor(Math.random() * words.length)] ?? 'swarmy';
  return `${pick()}-${pick()}-${pick()}-${pick()}`;
}

function endpointFor(st: StorageState): string | null {
  return st.enabled ? `http://${GARAGE_SERVICE}:${GARAGE_S3_PORT}` : null;
}

function getState(store: DemoStore): DataState {
  return store.extra.data as DataState;
}

// ── projections (state → the exact view a query returns) ─────────────────────

function storageView(st: StorageState): StorageClusterView {
  return {
    enabled: st.enabled,
    driver: st.driver,
    replicationFactor: st.replicationFactor,
    region: st.region,
    memberNodeIds: st.memberNodeIds,
    endpoint: endpointFor(st),
    hasAccessKeys: st.hasAccessKeys,
    updatedAt: st.updatedAt,
  };
}

function controllerView(c: ControllerBackupState): ControllerBackupConfigView {
  return {
    enabled: c.enabled,
    targetId: c.targetId,
    schedule: c.schedule,
    retention: c.retention,
    hasPassphrase: c.hasPassphrase,
    passphraseHint: c.passphraseHint,
    lastRunAt: c.lastRunAt,
    nextRunAt: c.nextRunAt,
  };
}

function targetName(st: DataState, targetId: string): string {
  return st.targets.find((t) => t.id === targetId)?.name ?? '';
}

/** +N units from now, mirroring the scheduler's nextRunAt. */
function nextRunFrom(every: number, unit: IntervalUnit): string {
  const ms = unit === 'minutes' ? every * MIN : unit === 'hours' ? every * HOUR : every * DAY;
  return new Date(Date.now() + ms).toISOString();
}

// ── DB backups (slice A1): projections + a light cron approximation ──────────

/** Rough next-occurrence for the demo (hourly steps read off the cron's hour field). */
function fakeCronNext(cron: string): string {
  const hourField = cron.trim().split(/\s+/)[1] ?? '*';
  const step = /^\*\/(\d+)$/.exec(hourField)?.[1];
  if (step) return new Date(Date.now() + Number(step) * HOUR).toISOString();
  if (hourField === '*') return new Date(Date.now() + HOUR).toISOString();
  return new Date(Date.now() + 9 * HOUR).toISOString();
}

function findDbCluster(st: DataState, stack: string, cluster: string): DbClusterState | undefined {
  return st.dbClusters.find((c) => c.stack === stack && c.cluster === cluster);
}

function dbScheduleView(c: DbClusterState): DbBackupScheduleView | null {
  if (!c.schedule) return null;
  return {
    stack: c.stack,
    cluster: c.cluster,
    cron: c.schedule.cron,
    engine: c.schedule.engine,
    retentionDays: c.schedule.retentionDays,
    pitr: c.schedule.pitr,
    targetId: c.schedule.targetId,
    dataVolume: c.schedule.dataVolume,
    lastRunAt: c.lastRunAt,
    lastStatus: c.lastStatus,
    nextRunAt: fakeCronNext(c.schedule.cron),
  };
}

function dbOverviewRow(st: DataState, c: DbClusterState): DbBackupOverviewRow {
  const s = c.schedule;
  const pitrWindow =
    s?.pitr && c.lastStatus === 'succeeded' && c.lastRunAt
      ? { from: iso(s.retentionDays * DAY), to: c.lastRunAt }
      : null;
  return {
    stack: c.stack,
    cluster: c.cluster,
    scheduled: s != null,
    cron: s?.cron ?? null,
    engine: s?.engine ?? null,
    retentionDays: s?.retentionDays ?? null,
    pitr: s?.pitr ?? false,
    targetId: s?.targetId ?? null,
    targetName: s?.targetId ? targetName(st, s.targetId) || null : null,
    lastBackupAt: c.lastRunAt,
    lastStatus: c.lastStatus,
    lastSizeBytes: c.lastSizeBytes,
    nextRunAt: s ? fakeCronNext(s.cron) : null,
    pitrWindow,
  };
}

function recordDbBackup(
  st: DataState,
  stack: string,
  cluster: string,
  engine: DbBackupEngine,
): { engine: DbBackupEngine; snapshotId: string; sizeBytes: string; databases: string[] } {
  const snapshotId = resticId();
  const sizeBytes = String(Math.floor(140_000_000 + Math.random() * 1_800_000_000));
  st.dbSnapshots = [
    {
      id: snapshotId,
      time: nowIso(),
      engine,
      sizeBytes,
      tags: ['org:org-demo', `db:${stack}/${cluster}`, `engine:${engine}`],
      stack,
      cluster,
    },
    ...st.dbSnapshots,
  ];
  const c = findDbCluster(st, stack, cluster);
  if (c) {
    c.lastRunAt = nowIso();
    c.lastStatus = 'succeeded';
    c.lastSizeBytes = sizeBytes;
  }
  return { engine, snapshotId, sizeBytes, databases: engine === 'pg_dumpall' ? ['app', 'analytics'] : ['app'] };
}

// ── db.get projection (slice A2): topology seed + A1 schedule state → view ────

function dbClusterView(st: DataState, t: DbTopoState): Record<string, unknown> {
  const primary = t.members.find((m) => m.role === 'primary');
  const replicas = t.members.filter((m) => m.role === 'replica');
  const desired = replicas.reduce((n, m) => n + m.desired, 0);
  const running = replicas.reduce((n, m) => n + m.running, 0);
  const lags = t.members.map((m) => m.lagSeconds).filter((v): v is number => v !== undefined);
  // PITR is Docker-truth off the backup schedule label — derive it live from the
  // A1 demo state so toggling the schedule flips the panel's WAL-shipping row.
  const pitr = findDbCluster(st, t.stack, t.cluster)?.schedule?.pitr ?? false;
  const base = `${t.stack}_${t.cluster}`;
  return {
    name: t.cluster,
    engine: 'postgres',
    primary: {
      service: primary?.service ?? `${base}-primary`,
      status: primary?.status ?? 'absent',
    },
    replicas: { desired, running },
    rwHost: primary?.service ?? `${base}-primary`,
    roHost: replicas[0]?.service ?? `${base}-replica`,
    declaredReplicas: desired,
    topology: t.topology,
    members: t.members,
    pitr,
    ...(pitr ? { walShipper: { service: `${base}-wal-shipper`, status: 'running' } } : {}),
    ...(lags.length > 0 ? { maxLagSeconds: Math.max(...lags) } : {}),
    ...(t.leader ? { leader: t.leader } : {}),
  };
}

export const data: DomainResolvers = {
  handlers: {
    // ── managed-DB topology (slice A2: db-cluster-panel) ─────────────────────
    'db.get': (i, s): { stack: string; clusters: Record<string, unknown>[] } => {
      const { stack } = i as { stack: string };
      const st = getState(s);
      return {
        stack,
        clusters: st.dbTopologies
          .filter((t) => t.stack === stack)
          .map((t) => dbClusterView(st, t))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      };
    },

    // ── backups ──────────────────────────────────────────────────────────────
    'backups.listTargets': (_i, s): BackupTargetView[] => getState(s).targets,

    'backups.addTarget': (i, s): BackupTargetView => {
      const b = i as {
        name: string;
        kind: BackupTargetKind;
        endpoint?: string;
        bucket: string;
        prefix?: string;
        region?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
      };
      const st = getState(s);
      const row: BackupTargetView = {
        id: rid('tgt'),
        name: b.name,
        kind: b.kind === 'node' ? 'node' : 's3',
        endpoint: b.endpoint ?? null,
        bucket: b.bucket,
        prefix: b.prefix ?? null,
        region: b.region ?? null,
        hasCredentials: Boolean(b.accessKeyId && b.secretAccessKey),
        enabled: true,
        createdAt: nowIso(),
      };
      st.targets = [row, ...st.targets];
      return row;
    },

    'backups.removeTarget': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.targets = st.targets.filter((t) => t.id !== id);
      return { id, removed: true };
    },

    'backups.listSnapshots': (i, s): SnapshotView[] => {
      const f = (i as { volume?: string; targetId?: string } | null | undefined) ?? {};
      return getState(s).snapshots.filter(
        (snap) => (!f.volume || snap.volume === f.volume) && (!f.targetId || snap.targetId === f.targetId),
      );
    },

    'backups.backupVolume': (i, s): { snapshotId: string; resticId: string; sizeBytes: string } => {
      const b = i as { targetId: string; volume: string; nodeId?: string };
      const st = getState(s);
      const rid8 = resticId();
      const sizeBytes = String(Math.floor(80_000_000 + Math.random() * 900_000_000));
      const snap: SnapshotView = {
        id: rid('snap'),
        volume: b.volume,
        targetId: b.targetId,
        targetName: targetName(st, b.targetId),
        status: 'SUCCEEDED',
        resticId: rid8,
        sizeBytes,
        error: null,
        startedAt: iso(2_000),
        finishedAt: nowIso(),
      };
      st.snapshots = [snap, ...st.snapshots];
      return { snapshotId: snap.id, resticId: rid8, sizeBytes };
    },

    'backups.restoreSnapshot': (i, s): { targetVolume: string; bytesRestored: string } => {
      const b = i as { snapshotId: string; targetVolume?: string; nodeId?: string };
      const st = getState(s);
      const snap = st.snapshots.find((x) => x.id === b.snapshotId);
      const targetVolume = b.targetVolume?.trim() || snap?.volume || 'restored-volume';
      const bytesRestored = snap?.sizeBytes ?? String(Math.floor(120_000_000 + Math.random() * 500_000_000));
      return { targetVolume, bytesRestored };
    },

    // ── schedules ──────────────────────────────────────────────────────────────
    'schedules.list': (_i, s): BackupScheduleView[] => getState(s).schedules,

    'schedules.listRestores': (_i, s): RestoreOperationView[] => getState(s).restores,

    'schedules.create': (i, s): BackupScheduleView => {
      const b = i as { targetId: string; volume: string; nodeId?: string; every: number; unit: IntervalUnit };
      const st = getState(s);
      const row: BackupScheduleView = {
        id: rid('sch'),
        targetId: b.targetId,
        volume: b.volume,
        nodeId: b.nodeId ?? null,
        every: b.every,
        unit: b.unit,
        paused: false,
        lastRunAt: null,
        nextRunAt: nextRunFrom(b.every, b.unit),
        createdAt: nowIso(),
      };
      st.schedules = [row, ...st.schedules];
      return row;
    },

    'schedules.setPaused': (i, s): BackupScheduleView => {
      const b = i as { id: string; paused: boolean };
      const st = getState(s);
      const row = st.schedules.find((x) => x.id === b.id);
      if (!row) throw new Error(`schedule ${b.id} not found`);
      row.paused = b.paused;
      row.nextRunAt = b.paused ? null : nextRunFrom(row.every, row.unit);
      return row;
    },

    'schedules.remove': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.schedules = st.schedules.filter((x) => x.id !== id);
      return { id, removed: true };
    },

    // ── controllerBackup ────────────────────────────────────────────────────────
    'controllerBackup.getConfig': (_i, s): ControllerBackupConfigView => controllerView(getState(s).controller),

    'controllerBackup.setConfig': (i, s): ControllerBackupConfigView => {
      const b = i as {
        targetId?: string | null;
        schedule?: string;
        enabled?: boolean;
        retention?: ControllerRetention;
      };
      const c = getState(s).controller;
      if (b.targetId !== undefined) c.targetId = b.targetId;
      if (b.schedule !== undefined) c.schedule = b.schedule;
      if (b.enabled !== undefined) c.enabled = b.enabled;
      if (b.retention !== undefined) c.retention = b.retention;
      return controllerView(c);
    },

    'controllerBackup.generatePassphrase': (): { passphrase: string } => ({ passphrase: passphrase() }),

    'controllerBackup.setPassphrase': (i, s): { fingerprint: string } => {
      const b = i as { passphrase: string };
      void b.passphrase;
      const c = getState(s).controller;
      const fp = fingerprint();
      c.hasPassphrase = true;
      c.passphraseHint = fp;
      return { fingerprint: fp };
    },

    'controllerBackup.runNow': (
      _i,
      s,
    ): { snapshotId: string; resticSnapshotId: string; sizeBytes: string } => {
      const c = getState(s).controller;
      if (!c.targetId) throw new Error('no backup target configured for controller backups');
      if (!c.hasPassphrase) throw new Error('no restore passphrase set — capture one before backing up');
      const rsid = resticId();
      const sizeBytes = String(Math.floor(20_000_000 + Math.random() * 60_000_000));
      const snap: ControllerSnapshotView = {
        id: rid('csnap'),
        targetId: c.targetId,
        resticSnapshotId: rsid,
        sizeBytes,
        durationMs: Math.floor(3_000 + Math.random() * 9_000),
        status: 'SUCCEEDED',
        manifest: {
          swarmyVersion: '0.1.0',
          schemaVersion: '1',
          dbDriver: 'postgres',
          createdAt: nowIso(),
          orgCount: 1,
          nodeCount: s.nodes.length,
          includedTables: 'control-plane',
        },
        startedAt: iso(4_000),
        finishedAt: nowIso(),
        error: null,
      };
      c.snapshots = [snap, ...c.snapshots];
      c.lastRunAt = nowIso();
      c.nextRunAt = nextRunFrom(1, 'days');
      return { snapshotId: snap.id, resticSnapshotId: rsid, sizeBytes };
    },

    'controllerBackup.listSnapshots': (_i, s): ControllerSnapshotView[] => getState(s).controller.snapshots,

    'controllerBackup.provisionManagedPostgres': (): {
      serviceName: string;
      databaseUrl: string;
      image: string;
      steps: string[];
    } => {
      const serviceName = 'swarmy-postgres';
      const image = 'postgres:16-alpine';
      const databaseUrl = `postgresql://swarmy:demo-secret@${serviceName}:5432/swarmy`;
      return {
        serviceName,
        databaseUrl,
        image,
        steps: [
          `1. Managed Postgres is running as swarm service "${serviceName}" (${image}).`,
          '2. Take a controller-state backup now (it produces a portable logical dump).',
          `3. Set SWARMY_DB_DRIVER=postgres and DATABASE_URL=${databaseUrl}`,
          '4. Run `bun db:migrate` (deploy) against the new DSN to create the schema.',
          '5. Restore the just-taken bundle to load control-plane data into managed PG.',
          '6. Restart the controller. Agents re-adopt automatically (hashed creds in DB).',
        ],
      };
    },

    // ── storage (replicated object store) ────────────────────────────────────────
    'storage.getConfig': (_i, s): StorageClusterView => storageView(getState(s).storage),

    'storage.status': (_i, s): StorageStatusView => {
      const st = getState(s).storage;
      return {
        enabled: st.enabled,
        driver: st.driver,
        members: st.memberNodeIds.map((nodeId) => ({
          nodeId,
          // Mirror the demo cluster: nodes are online unless draining/offline.
          online: s.nodes.find((n) => n.id === nodeId)?.status === 'online',
        })),
        endpoint: endpointFor(st),
      };
    },

    'storage.setDriver': (i, s): StorageClusterView => {
      const b = i as {
        driver: 'garage' | 'none';
        replicationFactor?: number;
        region?: string;
        memberNodeIds?: string[];
      };
      const st = getState(s).storage;
      st.driver = b.driver;
      if (b.replicationFactor !== undefined) st.replicationFactor = b.replicationFactor;
      if (b.region !== undefined) st.region = b.region;
      if (b.memberNodeIds !== undefined) st.memberNodeIds = b.memberNodeIds;
      st.updatedAt = nowIso();
      return storageView(st);
    },

    'storage.enable': (_i, s): StorageClusterView => {
      const st = getState(s).storage;
      // Fall back to the manager pair so a freshly-configured store has members.
      if (st.memberNodeIds.length === 0) st.memberNodeIds = ['n-mgr-1', 'n-mgr-2', 'n-wkr-1'];
      st.enabled = true;
      st.hasAccessKeys = true;
      st.updatedAt = nowIso();
      return storageView(st);
    },

    'storage.disable': (_i, s): StorageClusterView => {
      const st = getState(s).storage;
      st.enabled = false;
      st.updatedAt = nowIso();
      return storageView(st);
    },

    // ── dbBackups (slice A1: managed-cluster backups + schedule labels) ───────
    'dbBackups.overview': (_i, s): DbBackupOverviewRow[] => {
      const st = getState(s);
      return st.dbClusters
        .map((c) => dbOverviewRow(st, c))
        .sort((a, b) => `${a.stack}/${a.cluster}`.localeCompare(`${b.stack}/${b.cluster}`));
    },

    'dbBackups.getSchedule': (i, s): DbBackupScheduleView | null => {
      const b = i as { stack: string; cluster: string };
      const c = findDbCluster(getState(s), b.stack, b.cluster);
      return c ? dbScheduleView(c) : null;
    },

    'dbBackups.setSchedule': (i, s): DbBackupScheduleView | null => {
      const b = i as {
        enabled: boolean;
        stack: string;
        cluster: string;
        cron?: string;
        engine?: DbBackupEngine;
        retentionDays?: number;
        pitr?: boolean;
        targetId?: string;
        dataVolume?: string;
      };
      const st = getState(s);
      let c = findDbCluster(st, b.stack, b.cluster);
      if (!c) {
        c = { stack: b.stack, cluster: b.cluster, schedule: null, lastRunAt: null, lastStatus: null, lastSizeBytes: null };
        st.dbClusters = [...st.dbClusters, c];
      }
      if (!b.enabled) {
        c.schedule = null;
        return null;
      }
      c.schedule = {
        cron: b.cron ?? '0 3 * * *',
        engine: b.engine ?? 'pg_dump',
        retentionDays: b.retentionDays ?? 14,
        pitr: b.pitr ?? false,
        targetId: b.targetId ?? null,
        dataVolume: b.dataVolume ?? null,
      };
      return dbScheduleView(c);
    },

    'dbBackups.run': (i, s): { engine: DbBackupEngine; snapshotId: string; sizeBytes: string; databases: string[] } => {
      const b = i as { stack: string; cluster: string; engine?: DbBackupEngine };
      const st = getState(s);
      const engine = b.engine ?? findDbCluster(st, b.stack, b.cluster)?.schedule?.engine ?? 'pg_dump';
      return recordDbBackup(st, b.stack, b.cluster, engine);
    },

    'dbBackups.backup': (i, s): { engine: DbBackupEngine; snapshotId: string; sizeBytes: string; databases: string[] } => {
      const b = i as { stack: string; cluster: string; engine: DbBackupEngine };
      return recordDbBackup(getState(s), b.stack, b.cluster, b.engine);
    },

    'dbBackups.list': (i, s): DbBackupSnapshotView[] => {
      const f = (i as { stack?: string; cluster?: string } | null | undefined) ?? {};
      return getState(s)
        .dbSnapshots.filter(
          (snap) => (!f.stack || snap.stack === f.stack) && (!f.cluster || snap.cluster === f.cluster),
        )
        .map(({ stack: _st, cluster: _cl, ...view }) => view)
        .sort((a, b) => b.time.localeCompare(a.time));
    },

    'dbBackups.restore': (
      i,
      s,
    ): { mode: string; engine: DbBackupEngine; database?: string; bytesRestored: string; recoveredTo?: string } => {
      const b = i as {
        mode: string;
        engine: DbBackupEngine;
        snapshotId?: string;
        targetTime?: string;
        database?: string;
      };
      const snap = getState(s).dbSnapshots.find((x) => x.id === b.snapshotId);
      return {
        mode: b.mode,
        engine: b.engine,
        database: b.database,
        bytesRestored: snap?.sizeBytes ?? String(Math.floor(200_000_000 + Math.random() * 900_000_000)),
        ...(b.mode === 'pitr' ? { recoveredTo: b.targetTime ?? nowIso() } : {}),
      };
    },
  },

  seed: (store) => {
    // A coherent DR slice of the demo cluster: two S3 targets (one keyed, one
    // node-local), a catalog of recent snapshots across the data-stack volumes,
    // two active schedules + one paused, one automatic recovery on record, the
    // controller backup wired up (target + passphrase + nightly), and a Garage
    // store configured but not yet enabled (the page's "Enable" CTA lives).
    const tS3: BackupTargetView = {
      id: 'tgt-s3-primary',
      name: 'Backblaze B2 (primary)',
      kind: 's3',
      endpoint: 's3.eu-central-003.backblazeb2.com',
      bucket: 'northwind-backups',
      prefix: 'restic',
      region: 'eu-central-003',
      hasCredentials: true,
      enabled: true,
      createdAt: iso(30 * DAY),
    };
    const tNode: BackupTargetView = {
      id: 'tgt-node-local',
      name: 'On-node NVMe (mgr-1)',
      kind: 'node',
      endpoint: null,
      bucket: '/mnt/backups',
      prefix: null,
      region: null,
      hasCredentials: false,
      enabled: true,
      createdAt: iso(12 * DAY),
    };

    const snapshots: SnapshotView[] = [
      {
        id: 'snap-pg-1',
        volume: 's-data_postgres',
        targetId: tS3.id,
        targetName: tS3.name,
        status: 'SUCCEEDED',
        resticId: '9f3ac21b',
        sizeBytes: String(1_842_300_416),
        error: null,
        startedAt: iso(35 * MIN),
        finishedAt: iso(33 * MIN),
      },
      {
        id: 'snap-redis-1',
        volume: 's-data_redis',
        targetId: tS3.id,
        targetName: tS3.name,
        status: 'SUCCEEDED',
        resticId: '4c81de07',
        sizeBytes: String(96_468_992),
        error: null,
        startedAt: iso(2 * HOUR),
        finishedAt: iso(2 * HOUR - MIN),
      },
      {
        id: 'snap-grafana-1',
        volume: 's-platform_grafana',
        targetId: tNode.id,
        targetName: tNode.name,
        status: 'SUCCEEDED',
        resticId: 'b27f10aa',
        sizeBytes: String(312_058_880),
        error: null,
        startedAt: iso(6 * HOUR),
        finishedAt: iso(6 * HOUR - MIN),
      },
      {
        id: 'snap-pg-running',
        volume: 's-data_postgres',
        targetId: tS3.id,
        targetName: tS3.name,
        status: 'RUNNING',
        resticId: null,
        sizeBytes: null,
        error: null,
        startedAt: iso(20_000),
        finishedAt: null,
      },
      {
        id: 'snap-checkout-failed',
        volume: 's-store_checkout',
        targetId: tS3.id,
        targetName: tS3.name,
        status: 'FAILED',
        resticId: null,
        sizeBytes: null,
        error: 'repository locked by another process; retrying on next run',
        startedAt: iso(9 * HOUR),
        finishedAt: iso(9 * HOUR - 30_000),
      },
    ];

    const schedules: BackupScheduleView[] = [
      {
        id: 'sch-pg',
        targetId: tS3.id,
        volume: 's-data_postgres',
        nodeId: 'n-wkr-1',
        every: 6,
        unit: 'hours',
        paused: false,
        lastRunAt: iso(33 * MIN),
        nextRunAt: new Date(Date.now() + 5.5 * HOUR).toISOString(),
        createdAt: iso(20 * DAY),
      },
      {
        id: 'sch-redis',
        targetId: tS3.id,
        volume: 's-data_redis',
        nodeId: null,
        every: 1,
        unit: 'days',
        paused: false,
        lastRunAt: iso(2 * HOUR),
        nextRunAt: new Date(Date.now() + 22 * HOUR).toISOString(),
        createdAt: iso(20 * DAY),
      },
      {
        id: 'sch-grafana',
        targetId: tNode.id,
        volume: 's-platform_grafana',
        nodeId: 'n-mgr-2',
        every: 12,
        unit: 'hours',
        paused: true,
        lastRunAt: iso(6 * HOUR),
        nextRunAt: null,
        createdAt: iso(8 * DAY),
      },
    ];

    const restores: RestoreOperationView[] = [
      {
        id: 'rop-1',
        snapshotId: 'snap-redis-1',
        targetVolume: 's-data_redis',
        targetNodeId: 'n-wkr-2',
        status: 'SUCCEEDED',
        reason: 'node n-wkr-3 unreachable past grace window',
        bytesRestored: String(96_468_992),
        startedAt: iso(3 * DAY),
        finishedAt: iso(3 * DAY - 2 * MIN),
        error: null,
      },
    ];

    const controller: ControllerBackupState = {
      enabled: true,
      targetId: tS3.id,
      schedule: '0 3 * * *',
      retention: { ...DEFAULT_RETENTION },
      hasPassphrase: true,
      passphraseHint: 'a3f0c91e7b24',
      lastRunAt: iso(9 * HOUR),
      nextRunAt: new Date(Date.now() + 15 * HOUR).toISOString(),
      snapshots: [
        {
          id: 'csnap-1',
          targetId: tS3.id,
          resticSnapshotId: 'e10b73c2',
          sizeBytes: String(48_234_496),
          durationMs: 6_120,
          status: 'SUCCEEDED',
          manifest: {
            swarmyVersion: '0.1.0',
            schemaVersion: '1',
            dbDriver: 'postgres',
            createdAt: iso(9 * HOUR),
            orgCount: 1,
            nodeCount: 5,
            includedTables: 'control-plane',
          },
          startedAt: iso(9 * HOUR),
          finishedAt: iso(9 * HOUR - 6_000),
          error: null,
        },
        {
          id: 'csnap-2',
          targetId: tS3.id,
          resticSnapshotId: '7a52f0d9',
          sizeBytes: String(47_910_912),
          durationMs: 5_840,
          status: 'SUCCEEDED',
          manifest: {
            swarmyVersion: '0.1.0',
            schemaVersion: '1',
            dbDriver: 'postgres',
            createdAt: iso(33 * HOUR),
            orgCount: 1,
            nodeCount: 5,
            includedTables: 'control-plane',
          },
          startedAt: iso(33 * HOUR),
          finishedAt: iso(33 * HOUR - 6_000),
          error: null,
        },
      ],
    };

    const storage: StorageState = {
      enabled: false,
      driver: 'garage',
      replicationFactor: 3,
      region: 'swarmy',
      memberNodeIds: ['n-mgr-1', 'n-mgr-2', 'n-wkr-1'],
      hasAccessKeys: false,
      updatedAt: iso(2 * DAY),
    };

    // Managed-DB backup coverage: the data stack's cluster backs up 6-hourly with
    // PITR via wal-g; the storefront cluster dumps nightly; platform/metrics has
    // no schedule yet (the overview shows the gap → the CTA writes the label).
    const dbClusters: DbClusterState[] = [
      {
        stack: 'data',
        cluster: 'main',
        schedule: {
          cron: '0 */6 * * *',
          engine: 'wal-g',
          retentionDays: 14,
          pitr: true,
          targetId: tS3.id,
          dataVolume: 'data_main-primary-data',
        },
        lastRunAt: iso(50 * MIN),
        lastStatus: 'succeeded',
        lastSizeBytes: String(1_842_300_416),
      },
      {
        stack: 'storefront',
        cluster: 'checkout',
        schedule: {
          cron: '0 3 * * *',
          engine: 'pg_dump',
          retentionDays: 30,
          pitr: false,
          targetId: tS3.id,
          dataVolume: null,
        },
        lastRunAt: iso(9 * HOUR),
        lastStatus: 'failed',
        lastSizeBytes: null,
      },
      {
        stack: 'platform',
        cluster: 'metrics',
        schedule: null,
        lastRunAt: null,
        lastStatus: null,
        lastSizeBytes: null,
      },
    ];

    const dbSnap = (
      stack: string,
      cluster: string,
      engine: DbBackupEngine,
      msAgo: number,
      bytes: number,
    ): DbSnapshotState => ({
      id: resticId(),
      time: iso(msAgo),
      engine,
      sizeBytes: String(bytes),
      tags: ['org:org-demo', `db:${stack}/${cluster}`, `engine:${engine}`],
      stack,
      cluster,
    });

    const dbSnapshots: DbSnapshotState[] = [
      dbSnap('data', 'main', 'wal-g', 50 * MIN, 1_842_300_416),
      dbSnap('data', 'main', 'wal-g', 6 * HOUR + 50 * MIN, 1_831_204_992),
      dbSnap('data', 'main', 'wal-g', 12 * HOUR + 50 * MIN, 1_820_115_968),
      dbSnap('data', 'main', 'pg_dump', 26 * HOUR, 412_090_368),
      dbSnap('storefront', 'checkout', 'pg_dump', 33 * HOUR, 268_435_456),
      dbSnap('storefront', 'checkout', 'snapshot-from-replica', 57 * HOUR, 259_984_600),
    ];

    // Live cluster topologies (slice A2): the data/main cluster runs failover
    // with two healthy replicas + a consensus member (crowned leader, sub-second
    // lag, PITR shipping); storefront/checkout has one replica falling behind
    // (the amber lag badge); platform/metrics is a bare single-writer.
    const dbTopologies: DbTopoState[] = [
      {
        stack: 'data',
        cluster: 'main',
        topology: 'failover',
        leader: 'data_main-primary',
        members: [
          { service: 'data_main-primary', role: 'primary', status: 'running', desired: 1, running: 1 },
          { service: 'data_main-replica', role: 'replica', status: 'running', desired: 2, running: 2, lagSeconds: 0.4 },
          { service: 'data_main-dcs', role: 'dcs', status: 'running', desired: 1, running: 1 },
        ],
      },
      {
        stack: 'storefront',
        cluster: 'checkout',
        topology: 'primary-replica',
        leader: 'storefront_checkout-primary',
        members: [
          { service: 'storefront_checkout-primary', role: 'primary', status: 'running', desired: 1, running: 1 },
          { service: 'storefront_checkout-replica', role: 'replica', status: 'degraded', desired: 2, running: 1, lagSeconds: 14.2 },
        ],
      },
      {
        stack: 'platform',
        cluster: 'metrics',
        topology: 'single',
        leader: 'platform_metrics-primary',
        members: [
          { service: 'platform_metrics-primary', role: 'primary', status: 'running', desired: 1, running: 1 },
        ],
      },
    ];

    const state: DataState = {
      targets: [tS3, tNode],
      snapshots,
      schedules,
      restores,
      controller,
      storage,
      dbClusters,
      dbSnapshots,
      dbTopologies,
    };
    store.extra.data = state;
  },
};
