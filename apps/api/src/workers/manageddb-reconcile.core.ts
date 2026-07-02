import { createHash } from 'node:crypto';
import { WAL_ARCHIVE_MOUNT } from '@swarmy/core/protocol';

/**
 * Pure helpers for the manageddb-reconcile worker (slice A2 pitr-ha): failover
 * due-ness + promotion choice, Postgres LSN math, replica-lag parsing and
 * change-gated label stamping, the wal-shipper env/script renders and the
 * once-per-minute backup-sweep gate.
 *
 * Colocated in a `.core` module (the geodns-reconcile.core pattern) so the unit
 * tests exercise them without evaluating the worker's gateway/trpc import graph.
 * No network, no DB, no Docker — everything here is deterministic.
 */

/** Mirror of manageddb.service.ts `DB_LAG_LABEL_PREFIX` (worker cannot subpath-import). */
export const DB_LAG_LABEL_PREFIX = 'swarmy.db.lag.';

/** Consecutive unhealthy ticks a primary is granted before promotion fires. */
export const PROMOTION_GRACE_TICKS = 2;

/** Promotion due-ness: strictly MORE than the grace window of unhealthy ticks. */
export function promotionDue(unhealthyTicks: number, graceTicks: number = PROMOTION_GRACE_TICKS): boolean {
  return unhealthyTicks > graceTicks;
}

export interface PromotionCandidate {
  service: string;
  /** Running task count — 0 disqualifies (nothing to exec `pg_ctl promote` in). */
  running: number;
  /** Replay lag in seconds; null = unmeasured (sorts last). */
  lagSeconds: number | null;
  /** LSN byte distance behind the last-known primary LSN; tie-breaker. */
  lsnDiffBytes?: number | null;
}

/** Pick the promotion target: lowest lag → lowest LSN diff → stable name order. */
export function choosePromotionTarget(candidates: PromotionCandidate[]): string | null {
  const running = candidates.filter((c) => c.running > 0);
  if (running.length === 0) return null;
  const lag = (c: PromotionCandidate): number => c.lagSeconds ?? Number.POSITIVE_INFINITY;
  const diff = (c: PromotionCandidate): number => c.lsnDiffBytes ?? Number.POSITIVE_INFINITY;
  running.sort((a, b) => lag(a) - lag(b) || diff(a) - diff(b) || a.service.localeCompare(b.service));
  return running[0]!.service;
}

/** Parse a Postgres LSN (`16/B374D848`) into an absolute byte position. */
export function parseLsn(lsn: string): number | null {
  const m = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(lsn.trim());
  if (!m) return null;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return hi * 0x1_0000_0000 + lo;
}

/** Bytes the replica's replay LSN trails the primary's current LSN (>= 0). */
export function lsnDiffBytes(primaryLsn: string, replicaLsn: string): number | null {
  const p = parseLsn(primaryLsn);
  const r = parseLsn(replicaLsn);
  if (p === null || r === null) return null;
  return Math.max(0, p - r);
}

/** Parse the replica lag exec output: `<epoch-seconds-float>|<replay-lsn-or-empty>`. */
export function parseLagOutput(raw: string): { lagSeconds: number; replayLsn: string | null } | null {
  const line = raw
    .split(/\r?\n/)
    .map((t) => t.trim())
    .find((t) => t.length > 0 && t.includes('|'));
  if (!line) return null;
  const sep = line.indexOf('|');
  const secs = Number.parseFloat(line.slice(0, sep));
  if (!Number.isFinite(secs)) return null;
  const lsn = line.slice(sep + 1).trim();
  return { lagSeconds: Math.max(0, Math.round(secs * 10) / 10), replayLsn: lsn || null };
}

/** Label value for a lag sample (1-decimal seconds, clamped at 0). */
export function formatLagSeconds(n: number): string {
  return String(Math.max(0, Math.round(n * 10) / 10));
}

/**
 * Diff freshly measured member lag against the primary's current
 * `swarmy.db.lag.*` labels → a minimal updateLabels payload (null = no change).
 * Members that left the cluster get their stale label removed; members that
 * merely failed to answer this tick keep their last-known stamp.
 */
export function lagLabelUpdates(
  currentLabels: Record<string, string>,
  measured: Record<string, number>,
  liveMembers: string[],
): { add: Record<string, string>; removeKeys: string[] } | null {
  const add: Record<string, string> = {};
  for (const [member, secs] of Object.entries(measured)) {
    const key = `${DB_LAG_LABEL_PREFIX}${member}`;
    const value = formatLagSeconds(secs);
    if (currentLabels[key] !== value) add[key] = value;
  }
  const live = new Set(liveMembers);
  const removeKeys: string[] = [];
  for (const key of Object.keys(currentLabels)) {
    if (!key.startsWith(DB_LAG_LABEL_PREFIX)) continue;
    if (!live.has(key.slice(DB_LAG_LABEL_PREFIX.length))) removeKeys.push(key);
  }
  if (Object.keys(add).length === 0 && removeKeys.length === 0) return null;
  return { add, removeKeys };
}

/** Once-per-minute gate for the scheduled-backup sweep. */
export function minuteDue(lastMs: number | null, nowMs: number): boolean {
  return lastMs === null || nowMs - lastMs >= 60_000;
}

export interface WalCreds {
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
}

/**
 * Render the wal-shipper's env file (Docker secret content). `WALG_S3_PREFIX`
 * derives from bucket+prefix EXACTLY like the agent's `physicalEnv` does for
 * `db.backup`/`db.restore` wal-g runs, so base backups and shipped WAL share
 * one prefix and a `pitr` restore replays this archive.
 */
export function renderWalCredsEnv(t: WalCreds): string {
  const prefix = t.prefix ? `/${t.prefix.replace(/^\/+/, '')}` : '';
  const endpoint = t.endpoint
    ? /^https?:\/\//.test(t.endpoint)
      ? t.endpoint
      : `https://${t.endpoint}`
    : '';
  const lines = [
    `WALG_S3_PREFIX=s3://${t.bucket}${prefix}`,
    ...(endpoint ? [`AWS_ENDPOINT=${endpoint}`] : []),
    'AWS_S3_FORCE_PATH_STYLE=true',
    ...(t.accessKeyId ? [`AWS_ACCESS_KEY_ID=${t.accessKeyId}`] : []),
    ...(t.secretAccessKey ? [`AWS_SECRET_ACCESS_KEY=${t.secretAccessKey}`] : []),
    ...(t.region ? [`AWS_REGION=${t.region}`, `AWS_DEFAULT_REGION=${t.region}`] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/** Version marker for the applied PITR wiring (creds + data volume identity). */
export function pitrVersion(credsEnv: string, dataVolume: string | undefined): string {
  return createHash('sha256')
    .update(credsEnv)
    .update('\n')
    .update(dataVolume ?? '')
    .digest('hex')
    .slice(0, 10);
}

/** The wal-shipper loop: source creds, push each archived segment, delete local. */
export function shipperScript(): string {
  return [
    'set -u',
    'set -a; . /run/secrets/wal-creds; set +a',
    'while true; do',
    `  for f in ${WAL_ARCHIVE_MOUNT}/*; do`,
    '    [ -f "$f" ] || continue',
    '    if wal-g wal-push "$f"; then rm -f -- "$f"; fi',
    '  done',
    '  sleep 10',
    'done',
  ].join('\n');
}

/** Light mirror of dbBackup.service#parseScheduleLabel — only the PITR fields. */
export function parseScheduleLite(
  raw: string | undefined,
): { targetId?: string; dataVolume?: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return {
      ...(typeof v.targetId === 'string' && v.targetId ? { targetId: v.targetId } : {}),
      ...(typeof v.dataVolume === 'string' && v.dataVolume ? { dataVolume: v.dataVolume } : {}),
    };
  } catch {
    return null;
  }
}
