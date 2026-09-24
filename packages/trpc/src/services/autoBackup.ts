/**
 * Default-on database backups — the PURE half (no IO; golden-tested).
 *
 * Product decision: databases get nightly backups automatically, zero clicks.
 * Two populations, each riding the schedule model that already owns it:
 *
 *   - Managed Postgres clusters (`swarmy.db.*`): a daily LOGICAL backup
 *     (`pg_dump`) stamped as the `swarmy.db.backup.schedule` label on the
 *     primary, with `"auto": true` in the JSON. Docker truth, like every other
 *     managed-DB declaration.
 *   - Compose/blueprint databases (e.g. a WordPress blueprint's MariaDB on
 *     `wp_db-data`): a daily VOLUME backup — a `BackupSchedule` row with
 *     `auto = true`, the same row the user's own volume schedules live in.
 *
 * CONSISTENCY: a volume backup of a LIVE database is crash-consistent — the
 * same state the files would be in after a power cut. InnoDB / WAL-based
 * engines recover from that on start, but it is not a transaction-consistent
 * dump. Where the agent has a logical-dump engine for the DB type AND swarmy
 * owns the connection (managed Postgres → `pg_dump`), that is used instead.
 * Compose MySQL/MariaDB/Postgres/Mongo/Redis/Valkey keep the volume backup AND get a
 * logical dump on the same schedule (`appDbBackup.service.ts` — credentials
 * read in-task from the service's env/`_FILE` secrets; volume-only when they
 * can't be resolved).
 *
 * Never override the user: an existing schedule (auto or not) for the volume /
 * cluster is left alone, and a user REMOVING an auto schedule leaves an opt-out
 * marker (a tombstoned `BackupSchedule` row / the `swarmy.db.backup.auto=off`
 * label) so the loop never re-creates it.
 */
import type { SwarmServiceInfo } from '@swarmy/core/protocol';

/** Days an auto schedule keeps snapshots for. */
export const AUTO_BACKUP_RETENTION_DAYS = 7;
/** Opt-out marker on a managed Postgres primary: the user cleared the schedule. */
export const DB_BACKUP_AUTO_LABEL = 'swarmy.db.backup.auto';
export const DB_BACKUP_AUTO_OFF = 'off';
/** Name of the native swarmy object-store destination (mirrors backups.service). */
export const AUTO_NATIVE_TARGET_NAME = 'swarmy-object-storage';

const STACK_LABEL = 'com.docker.stack.namespace';
/** Labels that mark a swarmy-managed data member (backed up by its own domain). */
const MANAGED_PREFIXES = ['swarmy.db.', 'swarmy.cache.', 'swarmy.search.', 'swarmy.vector.'];

// ── detection ────────────────────────────────────────────────────────────────

export type DetectedDbEngine = 'mariadb' | 'mysql' | 'postgres' | 'mongo' | 'redis' | 'valkey';

/** Conservative image-name → engine map (the repo's LAST path segment only). */
const IMAGE_ENGINES: Record<string, DetectedDbEngine> = {
  mariadb: 'mariadb',
  mysql: 'mysql',
  postgres: 'postgres',
  postgresql: 'postgres',
  mongo: 'mongo',
  mongodb: 'mongo',
  redis: 'redis',
  valkey: 'valkey',
};

/** Where each engine keeps its data (official + bitnami layouts). */
const DATA_DIRS: Record<DetectedDbEngine, string[]> = {
  mariadb: ['/var/lib/mysql', '/bitnami/mariadb', '/bitnami'],
  mysql: ['/var/lib/mysql', '/bitnami/mysql', '/bitnami'],
  postgres: ['/var/lib/postgresql', '/bitnami/postgresql', '/bitnami'],
  mongo: ['/data/db', '/bitnami/mongodb', '/bitnami'],
  redis: ['/data', '/bitnami/redis', '/bitnami'],
  valkey: ['/data', '/bitnami/valkey', '/bitnami'],
};

/**
 * The DB engine an image ref runs, or null. Matches the repository's last path
 * segment exactly (`docker.io/library/mariadb:11@sha256:…` → mariadb,
 * `bitnami/postgresql:16` → postgres) — `my-mysql-exporter` or `redis-commander`
 * are NOT databases.
 */
export function detectDbEngine(image: string): DetectedDbEngine | null {
  let ref = image.trim().toLowerCase();
  const at = ref.indexOf('@');
  if (at >= 0) ref = ref.slice(0, at);
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > lastSlash) ref = ref.slice(0, colon);
  const repo = ref.slice(lastSlash + 1);
  return IMAGE_ENGINES[repo] ?? null;
}

export interface DetectedDb {
  stack: string;
  service: string;
  engine: DetectedDbEngine;
  /** The named data volume to back up. */
  volume: string;
}

function isNamedVolume(m: { type?: string; source?: string }): m is { type?: string; source: string } {
  if (!m.source) return false; // anonymous volume
  if (m.type && m.type !== 'volume') return false; // bind / tmpfs / npipe
  return !m.source.startsWith('/');
}

/** The primary of a managed queue cache (`swarmy.cache.purpose=queue`). */
function isQueuePrimary(s: SwarmServiceInfo): boolean {
  return s.labels['swarmy.cache.purpose'] === 'queue' && s.labels['swarmy.cache.role'] === 'primary';
}

function underDir(target: string, dir: string): boolean {
  const t = target.replace(/\/+$/, '');
  return t === dir || t.startsWith(`${dir}/`);
}

/**
 * DB-like services with a named data volume. Pure over live Docker truth
 * (`SwarmServiceInfo` carries `mounts`; `InvService` does not). Skips
 * swarmy-managed data members (their domain backs them up), swarmy's own
 * platform services, and services with no named volume (nothing durable).
 * Prefers the mount under the engine's data dir; else the first named volume.
 */
export function detectDbServices(services: SwarmServiceInfo[]): DetectedDb[] {
  const out: DetectedDb[] = [];
  for (const s of services) {
    const engine = detectDbEngine(s.image);
    if (!engine) continue;
    const stack = s.labels[STACK_LABEL];
    if (!stack || stack === 'swarmy-system') continue;
    // NOT `swarmy.managed=true`: every compose/blueprint service carries it, so
    // it can't tell a user's database from swarmy plumbing. Plumbing is the
    // `swarmy-` prefix or the system label; managed members are skipped below.
    if (s.name.startsWith('swarmy-') || s.labels['swarmy.system'] === 'true') continue;
    // A BullMQ-ready queue cache is the exception: its primary IS the job store
    // (noeviction, AOF), so it rides the same nightly volume copy + logical
    // valkey/redis dump as a compose DB (its password file is named in env).
    if (!isQueuePrimary(s) && Object.keys(s.labels).some((k) => MANAGED_PREFIXES.some((p) => k.startsWith(p)))) continue;
    const named = (s.mounts ?? []).flatMap((m) =>
      isNamedVolume(m) ? [{ source: m.source, target: m.target }] : [],
    );
    if (named.length === 0) continue;
    const dirs = DATA_DIRS[engine];
    const data =
      dirs.map((d) => named.find((m) => underDir(m.target, d))).find(Boolean) ?? named[0]!;
    out.push({ stack, service: s.name, engine, volume: data.source });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

// ── destination choice ──────────────────────────────────────────────────────

export interface AutoTargetCandidate {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  createdAt?: Date | string;
}

/**
 * The destination auto schedules write to: the native swarmy object store
 * (`swarmy-object-storage`) when present + enabled → the first enabled off-box
 * S3 target → a node-path target → none. Oldest wins within a tier so the
 * choice is stable across ticks.
 */
export function chooseAutoBackupTarget<T extends AutoTargetCandidate>(targets: T[]): T | null {
  const enabled = targets
    .filter((t) => t.enabled)
    .sort((a, b) => stamp(a.createdAt) - stamp(b.createdAt));
  const native = enabled.find((t) => t.name === AUTO_NATIVE_TARGET_NAME);
  if (native) return native;
  const s3 = enabled.find((t) => String(t.kind).toLowerCase() === 's3');
  if (s3) return s3;
  return enabled.find((t) => String(t.kind).toLowerCase() === 'node') ?? null;
}

function stamp(d: Date | string | undefined): number {
  if (!d) return 0;
  const n = new Date(d).getTime();
  return Number.isNaN(n) ? 0 : n;
}

// ── staggered nightly slot ──────────────────────────────────────────────────

/** 02:00–04:59 UTC = 180 one-minute slots. */
const WINDOW_START_HOUR = 2;
const WINDOW_MINUTES = 180;

/** FNV-1a 32-bit — stable across processes/runtimes (no Math.random, no crypto). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic nightly slot for `key` (e.g. `wp/wp_db-data`, `shop/main`)
 * within 02:00–04:59 UTC — so an estate of databases doesn't thundering-herd
 * the destination at 03:00.
 */
export function staggeredSlot(key: string): { hour: number; minute: number } {
  const offset = fnv1a(key) % WINDOW_MINUTES;
  return { hour: WINDOW_START_HOUR + Math.floor(offset / 60), minute: offset % 60 };
}

/** The slot as a 5-field UTC cron (`M H * * *`) for the managed-DB label. */
export function staggeredCron(key: string): string {
  const { hour, minute } = staggeredSlot(key);
  return `${minute} ${hour} * * *`;
}

/** The slot on `now`'s UTC day — the anchor of a daily interval schedule. */
export function staggeredAnchor(key: string, now: Date): Date {
  const { hour, minute } = staggeredSlot(key);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
}

// ── planning (what the loop should do for one database) ─────────────────────

/** Minimal existing-schedule shape the volume planner needs. */
export interface ExistingVolumeSchedule {
  volume: string;
  auto: boolean;
  optedOutAt: Date | string | null;
}

/**
 * Should the loop create an auto volume schedule for `volume`? Only when NO
 * row exists for it at all — a user schedule is never overridden, an existing
 * auto schedule is already covering it, and a tombstone is the user's opt-out.
 */
export function shouldCreateVolumeSchedule(
  volume: string,
  existing: ExistingVolumeSchedule[],
): boolean {
  return !existing.some((s) => s.volume === volume);
}

export type ManagedAutoPlan =
  | { action: 'none'; reason: 'user-schedule' | 'opted-out' | 'covered' | 'no-destination' | 'drill' }
  | { action: 'stamp'; targetId: string; cron: string; repoint: boolean };

/**
 * What to do for one managed cluster primary. `schedule` is the decoded
 * `swarmy.db.backup.schedule` label (null = none). An auto schedule whose
 * destination was removed/disabled is re-pointed at the current choice; a user
 * schedule is never touched.
 */
export function planManagedAutoSchedule(input: {
  stack: string;
  cluster: string;
  labels: Record<string, string>;
  schedule: { auto?: boolean; targetId?: string } | null;
  target: { id: string } | null;
  enabledTargetIds: ReadonlySet<string>;
}): ManagedAutoPlan {
  if (input.cluster.startsWith('drill-')) return { action: 'none', reason: 'drill' };
  if (input.schedule && !input.schedule.auto) return { action: 'none', reason: 'user-schedule' };
  if (!input.schedule && input.labels[DB_BACKUP_AUTO_LABEL] === DB_BACKUP_AUTO_OFF) {
    return { action: 'none', reason: 'opted-out' };
  }
  const cron = staggeredCron(`${input.stack}/${input.cluster}`);
  if (input.schedule?.auto) {
    const alive = input.schedule.targetId && input.enabledTargetIds.has(input.schedule.targetId);
    if (alive) return { action: 'none', reason: 'covered' };
    if (!input.target) return { action: 'none', reason: 'no-destination' };
    return { action: 'stamp', targetId: input.target.id, cron, repoint: true };
  }
  if (!input.target) return { action: 'none', reason: 'no-destination' };
  return { action: 'stamp', targetId: input.target.id, cron, repoint: false };
}
