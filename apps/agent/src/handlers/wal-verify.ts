/**
 * `dbWalVerify`: is a wal-g PITR cluster's WAL archive continuous? Read-only:
 * it touches no volume and no server.
 *
 * One wal-g sidecar, set up like the window check (same image, S3
 * credentials as container env, same networks), runs
 * `wal-g wal-verify integrity timeline --json`. wal-verify asks the live
 * primary for its current segment, so the sidecar gets the libpq env and the
 * password as its 0600 PGPASSFILE (the physical backup's contract). Then it
 * lists the archived WAL (`wal-g st ls wal_005/`) for upload times, which put
 * a time on each end of a gap, and the base backups.
 */
import { DEFAULT_COMMAND_TIMEOUTS } from '@swarmy/core/protocol';
import { pullHelper } from './helper-pull';
import type { DbWalVerifyPayload, DbWalVerifyResult, WalCheckStatus, WalRange, WalRangeStatus } from '@swarmy/core/protocol';
import type { DockerClient } from '@swarmy/core/docker';
import { S3_PREFLIGHT, pgConnEnv, physicalEnv, physicalNetworks, runSidecar, stderrTail } from './backup';
import { parseWalgBackups, walUploads } from './pitr-window';

/** Ends wal-verify's output; followed by its exit code. */
export const VERIFY_END = '--swarmy-wal-verify-rc--';
/** Separates the WAL listing from the base backup list. */
export const LISTING_END = '--swarmy-wal-listing-end--';

/** PURE: the sidecar script. wal-verify may fail (the parser says why); the listings are best-effort. */
export function walVerifyScript(): string {
  return (
    `set -e; ${S3_PREFLIGHT}rc=0; wal-g wal-verify integrity timeline --json || rc=$?; echo "${VERIFY_END} $rc"; ` +
    `wal-g st ls wal_005/ 2>/dev/null || true; echo '${LISTING_END}'; wal-g backup-list --json --detail 2>/dev/null || true`
  );
}

const STATUS: Record<string, WalRangeStatus> = {
  FOUND: 'found',
  MISSING_DELAYED: 'delayed',
  MISSING_UPLOADING: 'uploading',
  MISSING_LOST: 'lost',
};

function checkStatus(v: unknown): WalCheckStatus | null {
  const s = String(v ?? '').toLowerCase();
  return s === 'ok' || s === 'warning' || s === 'failure' ? s : null;
}

/** PURE: wal-verify's `--json` report → integrity, ranges (no times yet) and the timeline check. */
export function parseWalVerifyJson(text: string): Pick<DbWalVerifyResult, 'integrity' | 'ranges' | 'timeline'> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let doc: Record<string, { status?: unknown; details?: unknown }>;
  try {
    doc = JSON.parse(text.slice(start, end + 1)) as typeof doc;
  } catch {
    return null;
  }
  const integrity = checkStatus(doc.integrity?.status);
  if (!integrity) return null;
  const rows = Array.isArray(doc.integrity?.details) ? (doc.integrity.details as Array<Record<string, unknown>>) : [];
  const ranges: WalRange[] = [];
  for (const r of rows) {
    const raw = String(r.status ?? '');
    const status = STATUS[raw] ?? (raw.startsWith('MISSING') ? 'lost' : null);
    if (!status || typeof r.start_segment !== 'string' || typeof r.end_segment !== 'string') continue;
    ranges.push({
      timeline: Number(r.timeline_id) || 0,
      startSegment: r.start_segment,
      endSegment: r.end_segment,
      segments: Number(r.segments_count) || 0,
      status,
    });
  }
  const t = doc.timeline;
  const tStatus = checkStatus(t?.status);
  const td = (t?.details ?? {}) as Record<string, unknown>;
  return {
    integrity,
    ranges,
    ...(tStatus ? { timeline: { status: tStatus, current: Number(td.current_timeline_id) || 0, highestInStorage: Number(td.highest_storage_timeline_id) || 0 } } : {}),
  };
}

/**
 * PURE: put upload times on the ranges. A found range spans its first to its
 * last segment's upload; a missing one spans the found segments around it.
 */
export function timeRanges(ranges: readonly WalRange[], uploads: Map<string, number>): WalRange[] {
  const iso = (ms: number | undefined) => (ms != null ? new Date(ms).toISOString() : undefined);
  const timed = ranges.map((r) =>
    r.status === 'found' ? { ...r, from: iso(uploads.get(r.startSegment)), to: iso(uploads.get(r.endSegment)) } : { ...r },
  );
  return timed.map((r, i) => {
    if (r.status === 'found') return strip(r);
    const before = timed.slice(0, i).reverse().find((x) => x.status === 'found');
    const after = timed.slice(i + 1).find((x) => x.status === 'found');
    return strip({ ...r, from: before?.to, to: after?.from });
  });
}

const strip = (r: WalRange): WalRange =>
  Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as WalRange;

/** PURE: the whole result from the sidecar's stdout (stderr only for the failure's words). */
export function parseWalVerifyOutput(stdout: string, stderr: string, checkedAt: string): DbWalVerifyResult {
  const at = stdout.indexOf(VERIFY_END);
  const verify = at >= 0 ? stdout.slice(0, at) : stdout;
  const rest = at >= 0 ? stdout.slice(at + VERIFY_END.length) : '';
  const rc = Number(/^\s*(\d+)/.exec(rest)?.[1] ?? '0');
  const split = rest.indexOf(LISTING_END);
  const listing = split >= 0 ? rest.slice(0, split) : rest;
  const list = split >= 0 ? rest.slice(split + LISTING_END.length) : '';
  const report = parseWalVerifyJson(verify);
  if (!report) throw new Error(stderrTail(stderr, `wal-g wal-verify ${rc ? `exited ${rc}` : 'printed no report'}`));
  let backups: DbWalVerifyResult['backups'] = [];
  try {
    backups = parseWalgBackups(list);
  } catch {
    backups = [];
  }
  return { ...report, ranges: timeRanges(report.ranges, walUploads(listing)), backups, checkedAt };
}

/** Run the check on this node. */
export async function dbWalVerify(docker: DockerClient, p: DbWalVerifyPayload, now: () => number = Date.now): Promise<DbWalVerifyResult> {
  const { env } = physicalEnv(p.repo);
  const budget = p.timeoutMs ?? DEFAULT_COMMAND_TIMEOUTS.dbWalVerify ?? 300_000;
  const res = await runSidecar(docker, {
    image: await pullHelper(docker, 'walg', p.engineImage, p.fallbackEngineImage, p.registryAuth),
    entrypoint: ['/bin/sh', '-c'],
    args: [walVerifyScript()],
    env: [...env, ...pgConnEnv(p.conn)],
    pgPassword: p.conn.password,
    binds: [],
    ...physicalNetworks(p),
    timeout: { ms: Math.max(30_000, budget - 30_000), what: 'wal-g wal-verify' },
  });
  if (res.exitCode !== 0) throw new Error(stderrTail(res.stderr, `wal-g wal-verify exited ${res.exitCode}`));
  return parseWalVerifyOutput(res.stdout, res.stderr, new Date(now()).toISOString());
}
