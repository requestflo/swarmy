/**
 * `dbPitrWindow`: a managed Postgres cluster's recoverable window, read from
 * its WAL repo. Read-only: it touches no volume and no server.
 *
 * One wal-g sidecar, set up exactly as the PITR restore's own backup-list
 * (same image, S3 credentials as container env only, same networks), runs
 * `wal-g backup-list --json --detail`, then lists the archived WAL
 * (`wal-g st ls wal_005/`) best-effort for the newest change. The window
 * starts when the oldest base backup finished (recovery cannot stop before a
 * backup's end) and ends at the newest archived WAL segment, or at the check
 * time when the WAL listing could not be read.
 */
import { DEFAULT_COMMAND_TIMEOUTS, DEFAULT_WALG_IMAGE } from '@swarmy/core/protocol';
import type { DbPitrWindowPayload, DbPitrWindowResult, PitrBaseBackup } from '@swarmy/core/protocol';
import type { DockerClient } from '@swarmy/core/docker';
import { S3_PREFLIGHT, physicalEnv, physicalNetworks, runSidecar, stderrTail } from './backup';

/** Separates the backup list from the WAL listing in the sidecar's stdout. */
export const WAL_LISTING_MARKER = '--swarmy-wal-listing--';

/** PURE: the sidecar script. The WAL listing may fail; the backup list may not. */
export function walgWindowScript(): string {
  return `set -e; ${S3_PREFLIGHT}wal-g backup-list --json --detail; echo '${WAL_LISTING_MARKER}'; wal-g st ls wal_005/ 2>/dev/null || true`;
}

/**
 * PURE: the base backups in `wal-g backup-list --json --detail` output,
 * oldest first. Empty output is "no backups yet" (wal-g says so on stderr).
 */
export function parseWalgBackups(listJson: string): PitrBaseBackup[] {
  if (listJson.trim() === '') return [];
  let rows: unknown;
  try {
    rows = JSON.parse(listJson);
  } catch {
    throw new Error('could not read the wal-g backup list');
  }
  if (!Array.isArray(rows)) return [];
  const out: Array<PitrBaseBackup & { end: number }> = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const name = typeof r.backup_name === 'string' ? r.backup_name : '';
    const end = Date.parse(String(r.finish_time ?? r.time ?? ''));
    if (!name || !Number.isFinite(end)) continue;
    const start = Date.parse(String(r.start_time ?? ''));
    out.push({ name, finishTime: new Date(end).toISOString(), ...(Number.isFinite(start) ? { startTime: new Date(start).toISOString() } : {}), end });
  }
  return out.sort((a, b) => a.end - b.end).map(({ end: _end, ...b }) => b);
}

/** A 24-hex WAL segment name (optionally compressed: `.lz4`, `.br`, …). */
const SEGMENT_RE = /(?:^|\s|\/)[0-9A-F]{24}(?:\.[A-Za-z0-9]+)?\s*$/;
/** Go's `time.Time` text (`2026-10-24 09:15:00.123 +0000 UTC`) or an ISO time. */
const TIME_RE = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?/;

/**
 * PURE: the upload time of the newest archived WAL segment in a
 * `wal-g st ls` listing, or undefined when no line could be read.
 */
export function latestWalUpload(listing: string): string | undefined {
  let latest = Number.NEGATIVE_INFINITY;
  for (const line of listing.split(/\r?\n/)) {
    if (!SEGMENT_RE.test(line)) continue;
    const m = TIME_RE.exec(line);
    if (!m) continue;
    const frac = m[3] ? m[3].slice(0, 4) : '';
    const zone = !m[4] || m[4] === 'Z' ? 'Z' : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
    const at = Date.parse(`${m[1]}T${m[2]}${frac}${zone}`);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
}

/**
 * PURE: the recoverable window. From the oldest base backup's finish to the
 * newest archived change (never before the newest backup's finish), else to
 * the check time. Null with no base backups.
 */
export function pitrWindowOf(backups: readonly PitrBaseBackup[], latestWalAt: string | undefined, checkedAt: string): DbPitrWindowResult['window'] {
  if (backups.length === 0) return null;
  const from = backups[0]!.finishTime;
  const newest = backups[backups.length - 1]!.finishTime;
  const end = latestWalAt ?? checkedAt;
  return { from, to: Date.parse(end) >= Date.parse(newest) ? end : newest };
}

/** PURE: the whole result from the sidecar's stdout. */
export function parseWindowOutput(stdout: string, checkedAt: string): DbPitrWindowResult {
  const at = stdout.indexOf(WAL_LISTING_MARKER);
  const list = at >= 0 ? stdout.slice(0, at) : stdout;
  const wal = at >= 0 ? stdout.slice(at + WAL_LISTING_MARKER.length) : '';
  const backups = parseWalgBackups(list);
  const latestWalAt = latestWalUpload(wal);
  return { backups, window: pitrWindowOf(backups, latestWalAt, checkedAt), ...(latestWalAt ? { latestWalAt } : {}), checkedAt };
}

/** Run the read on this node. */
export async function dbPitrWindow(docker: DockerClient, p: DbPitrWindowPayload, now: () => number = Date.now): Promise<DbPitrWindowResult> {
  const { env } = physicalEnv(p.repo);
  const budget = p.timeoutMs ?? DEFAULT_COMMAND_TIMEOUTS.dbPitrWindow ?? 300_000;
  const res = await runSidecar(docker, {
    image: p.engineImage ?? DEFAULT_WALG_IMAGE,
    entrypoint: ['/bin/sh', '-c'],
    args: [walgWindowScript()],
    env,
    binds: [],
    ...physicalNetworks(p),
    timeout: { ms: Math.max(30_000, budget - 30_000), what: 'wal-g backup-list' },
  });
  if (res.exitCode !== 0) throw new Error(stderrTail(res.stderr, `wal-g backup-list exited ${res.exitCode}`));
  return parseWindowOutput(res.stdout, new Date(now()).toISOString());
}
