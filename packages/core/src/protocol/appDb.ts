/**
 * Logical backups for compose/blueprint databases ("app DBs"): MySQL, MariaDB,
 * MongoDB, Redis and Valkey services detected by `detectDbServices`
 * (`@swarmy/trpc` autoBackup). Managed Postgres keeps its own `dbBackup` path.
 *
 * How it runs (agent side, `apps/agent/src/handlers/appdb.ts`):
 *   1. find this node's running task of `service`;
 *   2. PROBE: a non-interactive exec inside that task prints the credentials
 *      the way a human would find them — `$MYSQL_ROOT_PASSWORD`, the file behind
 *      `$MYSQL_ROOT_PASSWORD_FILE`, redis' `--requirepass` — per the `creds`
 *      recipe the controller resolved from the service spec. The values stay in
 *      agent memory and one-shot container env: they never cross the WS, never
 *      touch node disk;
 *   3. DUMP: a one-shot sidecar from the task's OWN image (so the dump tool
 *      matches the server) sharing the task's network namespace
 *      (`container:<id>`, so it talks to 127.0.0.1 and needs no attachable
 *      overlay) writes the dump onto a scratch volume;
 *   4. STORE: restic backs the scratch volume up into the same catalog as every
 *      other backup (encrypted, deduped, compressed), then enforces retention.
 *
 * No stdin plumbing anywhere: exec/attach stdin is unreliable under Bun, so
 * every leg is "container writes a volume" or "container reads a volume".
 *
 * Subpath: `@swarmy/core/protocol`.
 */
import { z } from 'zod';
import { CommandId } from './primitives';
import { ContainerPath, DockerVolumeName, ResticRepo, RetentionOutcome, SnapshotRef } from './backup';

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

/** Engines with a logical-dump path (compose DBs; managed Postgres has its own `dbBackup`). */
export const AppDbEngine = z.enum(['mysql', 'mariadb', 'postgres', 'mongo', 'redis', 'valkey']);
export type AppDbEngine = z.infer<typeof AppDbEngine>;

/** Env-var names are interpolated into shell — keep them to POSIX identifiers. */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'invalid env var name');

/**
 * Where one credential field comes from, tried in order (first non-empty
 * wins). `file` names the env var that HOLDS a path (`MYSQL_ROOT_PASSWORD_FILE`
 * → `/run/secrets/db_root`). `literal` is for non-secrets (a user name).
 * `redis-cmdline` is `--requirepass` from the container's configured argv, else its redis.conf.
 */
export const AppDbCredSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: EnvName }),
  z.object({ kind: z.literal('file'), name: EnvName }),
  z.object({ kind: z.literal('literal'), value: z.string().max(256) }),
  z.object({ kind: z.literal('redis-cmdline') }),
]);
export type AppDbCredSource = z.infer<typeof AppDbCredSource>;

/** The recipe the probe follows — references only, never values. */
export const AppDbCreds = z.object({
  /** `root` (whole server), `user` (the app user's database), `none` (no auth). */
  scope: z.enum(['root', 'user', 'none']),
  user: z.array(AppDbCredSource).default([]),
  password: z.array(AppDbCredSource).default([]),
  /** Restrict the dump to this database (user scope). Empty = every user database. */
  database: z.array(AppDbCredSource).default([]),
  /** Mongo authentication database. */
  authDb: z.array(AppDbCredSource).default([]),
  port: z.number().int().min(1).max(65535),
});
export type AppDbCreds = z.infer<typeof AppDbCreds>;

/** Suffix for a restore-as-a-copy (`app` → `app_copy_202609241530`). */
export const AppDbCopySuffix = z.string().regex(/^[A-Za-z0-9_]{1,32}$/);

const target = {
  /** Swarm service name; the agent finds its running task on THIS node. */
  service: z.string().min(1),
  creds: AppDbCreds,
  /** Redis/Valkey: the data volume + where the task mounts it (RDB lives there). */
  dataVolume: DockerVolumeName.optional(),
  dataMount: ContainerPath.optional(),
};

const store = {
  repo: ResticRepo,
  /** Overlay the restic sidecar joins for in-cluster repos (`swarmy-garage`). */
  network: z.string().optional(),
  resticImage: z.string().optional(),
};

// ── appDbBackup ──────────────────────────────────────────────────────────────

export const AppDbBackupPayload = z.object({
  ...cmd,
  jobId: z.string(),
  engine: AppDbEngine,
  ...target,
  ...store,
  /** restic `--host` (groups this DB's snapshots; scopes retention). */
  host: z.string().min(1),
  /** restic tags, e.g. [`org:<id>`, `appdb:<stack>/<service>`, `engine:mysql`, `reason:scheduled`]. */
  tags: z.array(z.string()).default([]),
  /**
   * `restic forget --keep-within <N>d --prune` after a successful dump, scoped
   * to this DB's tags EXCEPT `reason:*` (so pre-restore safety dumps age out
   * with the nightly ones). Absent = keep forever.
   */
  retentionDays: z.number().int().min(1).max(3650).optional(),
});
export type AppDbBackupPayload = z.infer<typeof AppDbBackupPayload>;
export const AppDbBackupMsg = z.object({ type: z.literal('appDbBackup'), payload: AppDbBackupPayload });
export type AppDbBackupMsg = z.infer<typeof AppDbBackupMsg>;

export const AppDbBackupResult = z.object({
  snapshotId: z.string(),
  engine: AppDbEngine,
  sizeBytes: z.number().int().nonnegative().default(0),
  /** Databases captured (empty for Redis/Valkey — the RDB is the whole keyspace). */
  databases: z.array(z.string()).default([]),
  /** The dump tool actually used (`mariadb-dump`, `mysqldump`, `mongodump`, `redis-cli`). */
  tool: z.string().optional(),
  /** Redis/Valkey: RDB path relative to the data volume, and whether AOF is on. */
  rdbPath: z.string().optional(),
  appendonly: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  retention: RetentionOutcome.optional(),
});
export type AppDbBackupResult = z.infer<typeof AppDbBackupResult>;

// ── appDbRestore ─────────────────────────────────────────────────────────────

/**
 * - `copy` (the default the dashboard offers): non-destructive. SQL/Mongo load
 *   into renamed databases in the SAME server (`app` → `app_<suffix>`); Redis/
 *   Valkey write the RDB into a NEW volume (`copyVolume`).
 * - `in-place`: replace the live data. SQL/Mongo drop+recreate the dumped
 *   databases; Redis/Valkey overwrite the RDB in `dataVolume` — the controller
 *   has already scaled the service to 0 and scales it back after.
 */
export const AppDbRestoreMode = z.enum(['copy', 'in-place']);
export type AppDbRestoreMode = z.infer<typeof AppDbRestoreMode>;

export const AppDbRestorePayload = z.object({
  ...cmd,
  engine: AppDbEngine,
  mode: AppDbRestoreMode,
  ...target,
  ...store,
  /** restic snapshot id (a logical dump of this DB). */
  snapshotId: SnapshotRef,
  suffix: AppDbCopySuffix,
  /** Redis/Valkey copy: the new volume the RDB is written into. */
  copyVolume: DockerVolumeName.optional(),
});
export type AppDbRestorePayload = z.infer<typeof AppDbRestorePayload>;
export const AppDbRestoreMsg = z.object({ type: z.literal('appDbRestore'), payload: AppDbRestorePayload });
export type AppDbRestoreMsg = z.infer<typeof AppDbRestoreMsg>;

export const AppDbRestoreResult = z.object({
  mode: AppDbRestoreMode,
  engine: AppDbEngine,
  /** Databases written (renamed ones for a copy). */
  databases: z.array(z.string()).default([]),
  /** Redis/Valkey copy: the volume now holding the restored RDB. */
  volume: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AppDbRestoreResult = z.infer<typeof AppDbRestoreResult>;

// ── appDbVerify (backup-verify drill leg) ────────────────────────────────────

/**
 * Restore a dump into a throwaway container (`NetworkMode: none`, random
 * credentials minted on the node) from the service's image, run a sanity
 * query, remove everything. Touches nothing the app uses.
 */
export const AppDbVerifyPayload = z.object({
  ...cmd,
  engine: AppDbEngine,
  /** The service's image ref (the scratch server runs the same engine version). */
  image: z.string().min(1),
  ...store,
  snapshotId: SnapshotRef,
  /** Redis/Valkey: where the image keeps its data dir (the RDB is seeded there). */
  dataMount: ContainerPath.optional(),
});
export type AppDbVerifyPayload = z.infer<typeof AppDbVerifyPayload>;
export const AppDbVerifyMsg = z.object({ type: z.literal('appDbVerify'), payload: AppDbVerifyPayload });
export type AppDbVerifyMsg = z.infer<typeof AppDbVerifyMsg>;

export const AppDbVerifyResult = z.object({
  engine: AppDbEngine,
  databases: z.array(z.string()).default([]),
  /** Tables (SQL), collections (Mongo) or keys (Redis/Valkey) the scratch server reports. */
  objects: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AppDbVerifyResult = z.infer<typeof AppDbVerifyResult>;
