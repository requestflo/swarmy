/**
 * Trivy vulnerability-DB cache (self-reliance B6).
 *
 * Without a cache every scan downloads the ~60 MB trivy-db from GHCR, so scans
 * fail offline and a registry hiccup turns into "unscanned" everywhere. Instead:
 *
 *  - every scan and refresh mounts ONE node-local named volume
 *    (`swarmy-trivy-cache`) as trivy's `--cache-dir`;
 *  - a daily controller job (`refreshTrivyDbAllOrgs`, the `trivy-db-refresh`
 *    worker) runs `trivy image --download-db-only` once per scan node;
 *  - a scan skips the DB update when the cached DB is under a day old; when it
 *    is older it tries one update, and if that fails but a DB exists it scans
 *    against the stale DB and prints {@link TRIVY_DB_STALE_MARKER}.
 *
 * The admission gate treats a stale-DB scan as a WARNING (`images/scan-db-stale`)
 * and a missing DB (scan error) as `images/unscanned` (also a warning): the DB
 * being old or absent never blocks a deploy. Air-gapped estates point
 * `SWARMY_TRIVY_DB_REPOSITORY` at their own mirror of `trivy-db` (rule 4: every
 * default external URL gets a setting).
 *
 * The shell lives in the trivy image (alpine + busybox), so `sh`, `stat`,
 * `date` exist. The image ref is passed as an env var, never interpolated into
 * the script.
 */

/** Node-local named volume shared by every scan + refresh on that node. */
export const TRIVY_CACHE_VOLUME = 'swarmy-trivy-cache';
/** Mount point inside the trivy container (passed as `--cache-dir`). */
export const TRIVY_CACHE_DIR = '/swarmy-trivy-cache';
/** The cached DB counts as fresh (no update attempted) for this long. */
export const TRIVY_DB_FRESH_SECONDS = 24 * 60 * 60;
/** Printed on stderr when a scan ran against an out-of-date DB. */
export const TRIVY_DB_STALE_MARKER = '@@SWARMY-TRIVY-DB-STALE@@';
/** Printed by the refresh job after a successful download. */
export const TRIVY_DB_REFRESHED_MARKER = '@@SWARMY-TRIVY-DB-REFRESHED@@';

/** Env var carrying the ref to scan into the script (never shell-interpolated). */
const REF_ENV = 'SWARMY_SCAN_REF';

/**
 * `--db-repository` flags from the `SWARMY_TRIVY_DB_REPOSITORY` setting (comma
 * list, in priority order). Blank → trivy's built-in default (GHCR, then
 * mirror.gcr.io). Only registry-ref characters are accepted.
 */
export function trivyDbRepoArgs(setting: string | undefined = process.env.SWARMY_TRIVY_DB_REPOSITORY): string[] {
  const repos = (setting ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._\-/:@]+$/.test(s));
  return repos.length ? ['--db-repository', repos.join(',')] : [];
}

/** Single-quote for POSIX sh (only used on our own constant flags). */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `binds` entry every scan/refresh runOnce carries. */
export function trivyCacheBind(): string {
  return `${TRIVY_CACHE_VOLUME}:${TRIVY_CACHE_DIR}`;
}

/**
 * The scan script: use the cached DB when fresh, else try one update, and fall
 * back to the stale DB (with the marker) when the update fails. With no DB at
 * all trivy's own download runs (and a failure there is a scan ERROR, which
 * admission treats as `unscanned` → warn).
 */
export function renderTrivyScanScript(scanArgs: string[], dbRepoArgs: string[] = trivyDbRepoArgs()): string {
  const C = TRIVY_CACHE_DIR;
  const repo = dbRepoArgs.map(q).join(' ');
  const args = scanArgs.map(q).join(' ');
  return [
    `C=${q(C)}`,
    `M="$C/db/metadata.json"`,
    'SKIP=""',
    'if [ -f "$M" ]; then',
    '  AGE=$(( $(date +%s) - $(stat -c %Y "$M" 2>/dev/null || echo 0) ))',
    `  if [ "$AGE" -lt ${TRIVY_DB_FRESH_SECONDS} ]; then SKIP="--skip-db-update"; fi`,
    'fi',
    'if [ -z "$SKIP" ] && [ -f "$M" ]; then',
    `  if trivy image --download-db-only --cache-dir "$C" --quiet ${repo} >/dev/null 2>&1; then`,
    '    SKIP="--skip-db-update"',
    '  else',
    `    echo ${q(TRIVY_DB_STALE_MARKER)} >&2`,
    '    SKIP="--skip-db-update"',
    '  fi',
    'fi',
    `exec trivy image --cache-dir "$C" $SKIP ${repo} ${args} "$${REF_ENV}"`,
  ].join('\n');
}

/** Refresh-only script (daily job): download the DB into the shared cache. */
export function renderTrivyRefreshScript(dbRepoArgs: string[] = trivyDbRepoArgs()): string {
  const repo = dbRepoArgs.map(q).join(' ');
  return [
    `trivy image --download-db-only --cache-dir ${q(TRIVY_CACHE_DIR)} --quiet ${repo} || exit $?`,
    `echo ${q(TRIVY_DB_REFRESHED_MARKER)}`,
  ].join('\n');
}

/** The runOnce payload fields (entrypoint/cmd/env/binds) for a cached scan. */
export function trivyScanRunOnce(
  imageRef: string,
  scanArgs: string[],
  env: Record<string, string> = {},
  dbRepoArgs: string[] = trivyDbRepoArgs(),
): { entrypoint: string[]; cmd: string[]; env: Record<string, string>; binds: string[] } {
  return {
    entrypoint: ['/bin/sh', '-c'],
    cmd: [renderTrivyScanScript(scanArgs, dbRepoArgs)],
    env: { ...env, [REF_ENV]: imageRef },
    binds: [trivyCacheBind()],
  };
}

/** Did this scan's output say it ran against a stale DB? */
export function scanUsedStaleDb(output: string): boolean {
  return output.includes(TRIVY_DB_STALE_MARKER);
}
