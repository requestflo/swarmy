/**
 * Off-site mirror — PURE core (no ctx, no I/O; unit-tested).
 *
 * swarmy's own S3 (Garage) is mirrored into any S3-compatible off-site service
 * (Backblaze B2, Cloudflare R2, AWS S3, Wasabi, …) by a one-shot rclone
 * container on the `swarmy` overlay. Everything here builds or parses the
 * pieces of that one-shot:
 *
 *  - rclone remotes are configured ONLY through `RCLONE_CONFIG_<REMOTE>_*`
 *    container env, and rclone's global flags through `RCLONE_<FLAG>` env — so
 *    the argv (`cmd`) is a static shell script that never carries a key, a
 *    secret, or even a bucket name. Nothing is ever written to node disk.
 *  - the script loops the planned buckets, printing a marker per bucket so the
 *    controller can attribute rclone's final JSON stats line to each one.
 *  - `sync` mode propagates deletes through `--backup-dir` into a dated trash
 *    folder next to the mirror, purged after the grace window — so a delete
 *    (or an accidentally emptied bucket) is recoverable for `graceDays`.
 */
import type { RunOnceResult } from '@swarmy/core/protocol';

/** Pinned official rclone image. */
export const RCLONE_IMAGE = 'rclone/rclone:1.68.2';
/** Hard ceiling for one mirror/restore container (killed at this). */
export const MIRROR_TIMEOUT_MS = 4 * 60 * 60 * 1000;
/** Listing the off-site side (restore preview) is quick. */
export const LIST_TIMEOUT_MS = 2 * 60 * 1000;
/** A RUNNING row older than this was orphaned (controller restart mid-run). */
export const STALE_RUN_MS = MIRROR_TIMEOUT_MS + 15 * 60 * 1000;

export const DEFAULT_MIRROR_PREFIX = 'swarmy-mirror';
export const DEFAULT_EVERY_MINUTES = 60;
export const MIN_EVERY_MINUTES = 15;
export const MAX_EVERY_MINUTES = 7 * 24 * 60;
export const DEFAULT_GRACE_DAYS = 7;
/** Name of the controller-held Garage key the mirror reads (and restores) with. */
export const MIRROR_KEY_NAME = 'swarmy-offsite-mirror';
/** Trash folder (sibling of the mirrored buckets) that `sync` deletes land in. */
export const TRASH_DIR = '.swarmy-trash';

/** A mirror is "stale" when its last success is older than this. */
export const MIRROR_STALE_MS = 2 * 24 * 60 * 60 * 1000;

export type MirrorMode = 'copy' | 'sync';
export type MirrorDirection = 'mirror' | 'restore';

/** Conservative defaults: never saturate an uplink, retry transient S3 errors. */
export const DEFAULT_TUNING = {
  transfers: 4,
  checkers: 8,
  /** rclone --bwlimit (bytes/s, SI suffixes): 50 MiB/s. */
  bwlimit: '50M',
  retries: 3,
  lowLevelRetries: 10,
} as const;

export const BUCKET_MARKER = '__SWARMY_MIRROR_BUCKET__:';
export const EXIT_MARKER = '__SWARMY_MIRROR_EXIT__:';
export const PURGE_MARKER = '__SWARMY_MIRROR_PURGE__:';
export const LIST_MARKER = '__SWARMY_MIRROR_LIST__';

/** Garage bucket names (global aliases) — also what we let into the env list. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;

export function isValidBucketName(name: string): boolean {
  return BUCKET_NAME_RE.test(name) && !name.includes('..');
}

/** Normalize + validate a mirror prefix (path under the off-site bucket). */
export function normalizePrefix(prefix: string | null | undefined): string {
  const p = (prefix ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!p) return DEFAULT_MIRROR_PREFIX;
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error('prefix may only contain letters, digits, ".", "_", "-" and "/"');
  }
  return p;
}

/** `<offsite bucket>/<prefix>` — where each source bucket lands as a folder. */
export function offsiteRoot(targetBucket: string, prefix: string): string {
  const bucket = targetBucket.trim().replace(/^\/+|\/+$/g, '');
  return `${bucket}/${normalizePrefix(prefix)}`;
}

// ── rclone env config ────────────────────────────────────────────────────────

export interface S3RemoteConfig {
  endpoint?: string | null;
  region?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  /** rclone s3 provider; derived from the endpoint when omitted. */
  provider?: string;
}

/**
 * rclone `provider` for an S3 endpoint. Named providers get rclone's quirks
 * handled (R2's no-ACL, Wasabi's endpoint); everything else S3-compatible —
 * Backblaze B2's S3 API, MinIO, Garage — is `Other` with path-style addressing.
 */
export function s3ProviderFor(endpoint: string | null | undefined): string {
  if (!endpoint) return 'AWS';
  let host = endpoint;
  try {
    host = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`).hostname;
  } catch {
    // keep raw
  }
  if (host.endsWith('amazonaws.com')) return 'AWS';
  if (host.endsWith('r2.cloudflarestorage.com')) return 'Cloudflare';
  if (host.endsWith('wasabisys.com')) return 'Wasabi';
  return 'Other';
}

/** The `RCLONE_CONFIG_<REMOTE>_*` env that defines one s3 remote. */
export function rcloneRemoteEnv(remote: string, cfg: S3RemoteConfig): Record<string, string> {
  const R = `RCLONE_CONFIG_${remote.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const provider = cfg.provider ?? s3ProviderFor(cfg.endpoint);
  const env: Record<string, string> = {
    [`${R}_TYPE`]: 's3',
    [`${R}_PROVIDER`]: provider,
    [`${R}_ENV_AUTH`]: 'false',
    [`${R}_ACCESS_KEY_ID`]: cfg.accessKeyId,
    [`${R}_SECRET_ACCESS_KEY`]: cfg.secretAccessKey,
    // Buckets already exist (off-site: operator-created, Garage: admin API) —
    // don't need CreateBucket rights, and R2 rejects the probe.
    [`${R}_NO_CHECK_BUCKET`]: 'true',
  };
  if (cfg.endpoint) env[`${R}_ENDPOINT`] = cfg.endpoint;
  if (cfg.region) env[`${R}_REGION`] = cfg.region;
  if (provider === 'Other') env[`${R}_FORCE_PATH_STYLE`] = 'true';
  return env;
}

/** rclone global flags as env (never argv): checksums, bounded parallelism, JSON stats. */
export function rcloneFlagEnv(tuning: Partial<typeof DEFAULT_TUNING> = {}): Record<string, string> {
  const t = { ...DEFAULT_TUNING, ...tuning };
  return {
    RCLONE_CHECKSUM: 'true',
    RCLONE_TRANSFERS: String(t.transfers),
    RCLONE_CHECKERS: String(t.checkers),
    RCLONE_BWLIMIT: t.bwlimit,
    RCLONE_RETRIES: String(t.retries),
    RCLONE_LOW_LEVEL_RETRIES: String(t.lowLevelRetries),
    RCLONE_FAST_LIST: 'true',
    RCLONE_USE_JSON_LOG: 'true',
    RCLONE_LOG_LEVEL: 'NOTICE',
    // One final stats line per invocation (the run is killed long before 1h
    // stats would repeat much) at a level NOTICE logging shows.
    RCLONE_STATS: '1h',
    RCLONE_STATS_LOG_LEVEL: 'NOTICE',
  };
}

// ── scripts (static — every variable part rides env) ─────────────────────────

/**
 * Store → off-site. `copy` never deletes; `sync` deletes into the dated trash
 * (`--backup-dir`) and purges trash older than the grace window. Buckets named
 * in MIRROR_COPY_ONLY are copied even in sync mode (empty-source guard).
 */
export function buildMirrorScript(): string {
  return [
    'set -u',
    'rc=0',
    'for b in $MIRROR_BUCKETS; do',
    `  echo "${BUCKET_MARKER}$b"`,
    '  case " ${MIRROR_COPY_ONLY:-} " in',
    '    *" $b "*) op=copy ;;',
    '    *) op="$MIRROR_MODE" ;;',
    '  esac',
    '  if [ "$op" = sync ]; then',
    `    rclone sync "garage:$b" "offsite:$OFFSITE_ROOT/$b" --backup-dir "offsite:$OFFSITE_ROOT/${TRASH_DIR}/$MIRROR_RUN_ID/$b"`,
    '  else',
    '    rclone copy "garage:$b" "offsite:$OFFSITE_ROOT/$b"',
    '  fi',
    '  code=$?',
    `  echo "${EXIT_MARKER}$code"`,
    '  [ "$code" -ne 0 ] && rc=$code',
    'done',
    'if [ "$MIRROR_MODE" = sync ]; then',
    `  echo "${PURGE_MARKER}start"`,
    `  rclone delete "offsite:$OFFSITE_ROOT/${TRASH_DIR}" --min-age "$MIRROR_GRACE" --rmdirs || true`,
    `  echo "${PURGE_MARKER}done"`,
    'fi',
    'exit $rc',
  ].join('\n');
}

/** Off-site → store. Always `copy` — a restore never deletes anything in Garage. */
export function buildRestoreScript(): string {
  return [
    'set -u',
    'rc=0',
    'for b in $MIRROR_BUCKETS; do',
    `  echo "${BUCKET_MARKER}$b"`,
    '  rclone copy "offsite:$OFFSITE_ROOT/$b" "garage:$b"',
    '  code=$?',
    `  echo "${EXIT_MARKER}$code"`,
    '  [ "$code" -ne 0 ] && rc=$code',
    'done',
    'exit $rc',
  ].join('\n');
}

/** List the bucket folders present off-site (restore preview / plan). */
export function buildListScript(): string {
  return [
    'set -u',
    `echo "${LIST_MARKER}"`,
    'rclone lsf --dirs-only "offsite:$OFFSITE_ROOT"',
  ].join('\n');
}

export interface MirrorPayloadInput {
  direction: MirrorDirection | 'list';
  /** The Garage side — omitted for `list`, which only reads off-site. */
  source?: S3RemoteConfig;
  offsite: S3RemoteConfig;
  root: string;
  buckets: string[];
  copyOnly?: string[];
  mode?: MirrorMode;
  graceDays?: number;
  runId?: string;
  network: string;
  tuning?: Partial<typeof DEFAULT_TUNING>;
}

/**
 * The `container.runOnce` payload. Secrets live ONLY in `env`; `cmd` is one
 * of the static scripts above. Pure — the tests assert no secret reaches argv.
 */
export function buildMirrorRunOnce(input: MirrorPayloadInput) {
  for (const b of [...input.buckets, ...(input.copyOnly ?? [])]) {
    if (!isValidBucketName(b)) throw new Error(`invalid bucket name "${b}"`);
  }
  if (input.direction !== 'list' && !input.source) {
    throw new Error('mirror/restore needs the object-store credentials');
  }
  const script =
    input.direction === 'mirror'
      ? buildMirrorScript()
      : input.direction === 'restore'
        ? buildRestoreScript()
        : buildListScript();
  const env: Record<string, string> = {
    ...(input.source
      ? rcloneRemoteEnv('garage', { ...input.source, provider: input.source.provider ?? 'Other' })
      : {}),
    ...rcloneRemoteEnv('offsite', input.offsite),
    ...rcloneFlagEnv(input.tuning),
    OFFSITE_ROOT: input.root,
    MIRROR_BUCKETS: input.buckets.join(' '),
    MIRROR_COPY_ONLY: (input.copyOnly ?? []).join(' '),
    MIRROR_MODE: input.mode ?? 'copy',
    MIRROR_GRACE: `${input.graceDays ?? DEFAULT_GRACE_DAYS}d`,
    MIRROR_RUN_ID: input.runId ?? 'manual',
  };
  const timeoutMs = input.direction === 'list' ? LIST_TIMEOUT_MS : MIRROR_TIMEOUT_MS;
  return {
    image: RCLONE_IMAGE,
    entrypoint: ['/bin/sh', '-c'],
    cmd: [script],
    env,
    networks: [input.network],
    pull: true,
    timeoutMs,
  };
}

// ── planning + guards ────────────────────────────────────────────────────────

export interface StoreBucket {
  id: string;
  name: string;
  objects: number;
}

export interface MirrorBucketPlan {
  /** Buckets this run mirrors (sorted). */
  buckets: Array<{ id: string; name: string }>;
  /** Sync-mode buckets downgraded to copy because the source is empty. */
  copyOnly: string[];
  /** Explicitly selected buckets that don't exist in the store. */
  missing: string[];
}

/**
 * Which buckets a run mirrors. `all` = every bucket in the store (backups,
 * edge certs, app buckets). In `sync` mode an EMPTY source bucket is copied,
 * never synced — an emptied/recreated bucket must not wipe its off-site copy.
 */
export function planMirrorBuckets(input: {
  allBuckets: boolean;
  selected: string[];
  mode: MirrorMode;
  store: StoreBucket[];
}): MirrorBucketPlan {
  const byName = new Map(input.store.map((b) => [b.name, b]));
  const wanted = input.allBuckets ? input.store.map((b) => b.name) : input.selected;
  const buckets: Array<{ id: string; name: string }> = [];
  const missing: string[] = [];
  const copyOnly: string[] = [];
  for (const name of [...new Set(wanted)].sort()) {
    const b = byName.get(name);
    if (!b) {
      missing.push(name);
      continue;
    }
    if (!isValidBucketName(name)) continue;
    buckets.push({ id: b.id, name });
    if (input.mode === 'sync' && b.objects === 0) copyOnly.push(name);
  }
  return { buckets, copyOnly, missing };
}

export interface OffsiteTargetLike {
  name: string;
  kind: string;
  endpoint: string | null;
  bucket: string;
  hasCredentials: boolean;
  /** True when the endpoint only resolves inside the swarm (Garage itself). */
  inCluster: boolean;
}

/** Why a backup target can't be an off-site destination, or null when it can. */
export function offsiteTargetProblem(t: OffsiteTargetLike): string | null {
  if (String(t.kind).toLowerCase() !== 's3') return 'node-path destinations are not off-site';
  if (t.inCluster) return 'this destination lives in swarmy’s own object store — not off-site';
  if (!t.hasCredentials) return 'add S3 access keys to this destination first';
  if (!t.bucket.trim()) return 'destination has no bucket';
  return null;
}

/** Interval-anchored next run strictly after `from`. */
export function nextMirrorRun(everyMinutes: number, anchor: Date, from: Date): Date {
  const step = Math.max(everyMinutes, MIN_EVERY_MINUTES) * 60_000;
  const a = anchor.getTime();
  const f = from.getTime();
  if (f < a) return new Date(a);
  return new Date(a + (Math.floor((f - a) / step) + 1) * step);
}

/**
 * The next scheduled run, derived (no stored `nextRunAt`): the first interval
 * slot, anchored at the mirror's creation, after its newest mirror run.
 * Null = it has never run (or was just re-armed) — due on the next tick.
 */
export function mirrorNextRunAt(everyMinutes: number, createdAt: Date, lastRunAt: Date | null): Date | null {
  return lastRunAt ? nextMirrorRun(everyMinutes, createdAt, lastRunAt) : null;
}

/** Whether a scheduled run is due now. A paused (disabled) mirror never is. */
export function isMirrorDue(
  m: { enabled: boolean; nextRunAt: Date | null },
  now: Date,
  running: boolean,
): boolean {
  if (!m.enabled || running) return false;
  return m.nextRunAt == null || m.nextRunAt.getTime() <= now.getTime();
}

/**
 * Restore guard — "Restore from offsite" copies the off-site copy back into
 * Garage. Admin-only at the router; here: the typed confirmation must match
 * the destination name, the destination must be a real off-site S3 target,
 * the store must be up, and no mirror/restore may be in flight (a concurrent
 * sync could race the restore). Returns the refusal, or null when allowed.
 */
export function restoreGuard(input: {
  confirm: string;
  target: OffsiteTargetLike | null;
  storeState: 'ready' | 'disabled' | 'unreachable';
  running: boolean;
}): string | null {
  if (!input.target) return 'no off-site mirror is configured';
  const problem = offsiteTargetProblem(input.target);
  if (problem) return problem;
  if (input.confirm.trim() !== input.target.name) {
    return `type the destination name "${input.target.name}" to confirm the restore`;
  }
  if (input.storeState === 'disabled') {
    return 'object storage is off — enable the replicated store first, then restore into it';
  }
  if (input.storeState === 'unreachable') return 'object store unreachable — try again shortly';
  if (input.running) return 'a mirror or restore is already running — wait for it to finish';
  return null;
}

// ── output parsing ───────────────────────────────────────────────────────────

export interface BucketRunStats {
  bucket: string;
  objects: number;
  bytes: number;
  deletes: number;
  errors: number;
  /** rclone's per-bucket exit code; null when the marker was lost to the output tail cap. */
  exitCode: number | null;
  lastError?: string;
}

interface RcloneStats {
  bytes?: number;
  transfers?: number;
  deletes?: number;
  errors?: number;
  lastError?: string;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Split rclone output into per-bucket stats (last JSON stats line wins). */
export function parseMirrorOutput(output: string): BucketRunStats[] {
  const out: BucketRunStats[] = [];
  let cur: BucketRunStats | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith(BUCKET_MARKER)) {
      cur = {
        bucket: line.slice(BUCKET_MARKER.length).trim(),
        objects: 0,
        bytes: 0,
        deletes: 0,
        errors: 0,
        exitCode: null,
      };
      out.push(cur);
      continue;
    }
    if (line.startsWith(PURGE_MARKER)) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith(EXIT_MARKER)) {
      const code = Number.parseInt(line.slice(EXIT_MARKER.length).trim(), 10);
      cur.exitCode = Number.isNaN(code) ? null : code;
      continue;
    }
    const j = parseJsonLine(line);
    if (!j) continue;
    const stats = j.stats as RcloneStats | undefined;
    if (stats && typeof stats === 'object') {
      cur.objects = num(stats.transfers);
      cur.bytes = num(stats.bytes);
      cur.deletes = num(stats.deletes);
      cur.errors = num(stats.errors);
      if (typeof stats.lastError === 'string' && stats.lastError) cur.lastError = stats.lastError;
    } else if (j.level === 'error' && typeof j.msg === 'string' && !cur.lastError) {
      cur.lastError = j.msg.trim().slice(0, 500);
    }
  }
  return out;
}

/** Bucket folder names in `rclone lsf --dirs-only` output (trash/hidden dropped). */
export function parseOffsiteBucketList(output: string): string[] {
  const idx = output.indexOf(LIST_MARKER);
  const body = idx >= 0 ? output.slice(idx + LIST_MARKER.length) : output;
  const names = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('/'))
    .map((l) => l.slice(0, -1))
    .filter((n) => !n.startsWith('.') && isValidBucketName(n));
  return [...new Set(names)].sort();
}

export interface RunSummary {
  status: 'SUCCEEDED' | 'FAILED';
  objectsCopied: number;
  bytesCopied: number;
  deletes: number;
  errorCount: number;
  buckets: BucketRunStats[];
  error: string | null;
}

/** Fold a runOnce result into the run row's outcome. */
export function summarizeRun(result: RunOnceResult): RunSummary {
  const buckets = parseMirrorOutput(result.output);
  const sum = (k: 'objects' | 'bytes' | 'deletes' | 'errors') =>
    buckets.reduce((n, b) => n + b[k], 0);
  const failedBuckets = buckets.filter((b) => b.exitCode != null && b.exitCode !== 0);
  const failed = Boolean(result.timedOut) || result.exitCode !== 0 || failedBuckets.length > 0;
  let error: string | null = null;
  if (result.timedOut) {
    error = `timed out after ${Math.round(MIRROR_TIMEOUT_MS / 3_600_000)}h — the next run resumes where this one stopped`;
  } else if (failed) {
    const first = failedBuckets[0] ?? buckets.find((b) => b.lastError);
    error = first
      ? `${first.bucket}: ${first.lastError ?? `rclone exited ${first.exitCode}`}`
      : result.output.trim().slice(-500) || `rclone exited ${result.exitCode}`;
  }
  return {
    status: failed ? 'FAILED' : 'SUCCEEDED',
    objectsCopied: sum('objects'),
    bytesCopied: sum('bytes'),
    deletes: sum('deletes'),
    errorCount: sum('errors') + (failed && sum('errors') === 0 ? 1 : 0),
    buckets,
    error,
  };
}
