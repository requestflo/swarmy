/**
 * `dbWalgCopy`: copy a wal-g PITR cluster's base backup, and the WAL archived
 * since it, into a second destination ("also copy to"). It touches no volume
 * and no server: storage to storage.
 *
 * `wal-g copy` takes each storage as a config FILE. Both sides' S3
 * coordinates and credentials arrive as container env (`SWARMY_FROM_*`,
 * `SWARMY_TO_*`, the physical backup's contract); the script writes the two
 * files to the sidecar's own /dev/shm (tmpfs: memory, never node disk, gone
 * with the container), 0600, and never puts a value on argv. Then it reads
 * the copy's own base backups and WAL listing back, so the controller learns
 * how far a restore from the copy reaches.
 */
import { DEFAULT_COMMAND_TIMEOUTS } from '@swarmy/core/protocol';
import type { DbWalgCopyPayload, DbWalgCopyResult } from '@swarmy/core/protocol';
import type { DockerClient } from '@swarmy/core/docker';
import { assertSnapshotRef, physicalEnv, physicalNetworks, runSidecar, stderrTail } from './backup';
import { pullHelper } from './helper-pull';
import { WAL_LISTING_MARKER, parseWindowOutput } from './pitr-window';

/** Printed once the copy is done, followed by the base backup it copied. */
export const COPY_DONE = '--swarmy-walg-copied--';

/** The wal-g settings a storage config carries (each from `SWARMY_<SIDE>_<KEY>`). */
const KEYS = 'WALG_S3_PREFIX AWS_ENDPOINT AWS_S3_FORCE_PATH_STYLE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION';

/**
 * PURE: the sidecar script. Values only ever come from env: `cfg` writes each
 * set key as a single-quoted YAML scalar (quotes doubled), and the name of the
 * base backup to copy is `$SWARMY_BACKUP_NAME` (`LATEST` = the newest).
 */
export function walgCopyScript(): string {
  return [
    'set -e',
    'umask 077',
    // tmpfs; SWARMY_SHM is only ever set by the script's own test (no /dev/shm on a Mac).
    'c="${SWARMY_SHM:-/dev/shm}/swarmy-walg-copy"',
    'mkdir -p "$c"',
    `trap 'rm -rf "$c"' EXIT`,
    'for h in "${SWARMY_FROM_SWARMY_S3_HOST:-}" "${SWARMY_TO_SWARMY_S3_HOST:-}"; do if [ -n "$h" ] && command -v getent >/dev/null 2>&1 && ! getent hosts "$h" >/dev/null; then ' +
      'echo "swarmy: the backup destination host $h does not resolve from the copy sidecar (is it on the storage network?)" >&2; exit 3; fi; done',
    `cfg() { : > "$2"; for k in ${KEYS}; do eval "v=\\\${SWARMY_$1_$k:-}"; [ -n "$v" ] || continue; printf "%s: '%s'\\n" "$k" "$(printf '%s' "$v" | sed "s/'/''/g")" >> "$2"; done; }`,
    'cfg FROM "$c/from.yaml"',
    'cfg TO "$c/to.yaml"',
    'n="$SWARMY_BACKUP_NAME"',
    `if [ "$n" = LATEST ]; then n=$(wal-g --config "$c/from.yaml" backup-list 2>/dev/null | awk 'NR > 1 { last = $1 } END { print last }'); fi`,
    'if [ -z "$n" ]; then echo "swarmy: there is no base backup to copy yet" >&2; exit 4; fi',
    'wal-g --config "$c/from.yaml" copy --from "$c/from.yaml" --to "$c/to.yaml" --backup-name "$n" >&2',
    `echo "${COPY_DONE} $n"`,
    'wal-g --config "$c/to.yaml" backup-list --json --detail',
    `echo '${WAL_LISTING_MARKER}'`,
    'wal-g --config "$c/to.yaml" st ls wal_005/ 2>/dev/null || true',
  ].join('; ');
}

/** PURE: one side's wal-g env, renamed `SWARMY_<SIDE>_<KEY>` so neither side is wal-g's default. */
export function sideEnv(side: 'FROM' | 'TO', env: readonly string[]): string[] {
  return env.map((kv) => `SWARMY_${side}_${kv}`);
}

/** PURE: the base backup copied and the copy's own window, from the sidecar's stdout. */
export function parseCopyOutput(stdout: string, checkedAt: string): DbWalgCopyResult {
  const at = stdout.lastIndexOf(COPY_DONE);
  if (at < 0) throw new Error('wal-g copy did not report what it copied');
  const rest = stdout.slice(at + COPY_DONE.length);
  const nl = rest.indexOf('\n');
  const backupName = (nl >= 0 ? rest.slice(0, nl) : rest).trim();
  return { backupName, ...parseWindowOutput(nl >= 0 ? rest.slice(nl + 1) : '', checkedAt) };
}

/** Run the copy on this node. */
export async function dbWalgCopy(docker: DockerClient, p: DbWalgCopyPayload, now: () => number = Date.now): Promise<DbWalgCopyResult> {
  const name = p.backupName.toLowerCase() === 'latest' ? 'LATEST' : assertSnapshotRef(p.backupName);
  const env = [...sideEnv('FROM', physicalEnv(p.from).env), ...sideEnv('TO', physicalEnv(p.to).env), `SWARMY_BACKUP_NAME=${name}`];
  const budget = p.timeoutMs ?? DEFAULT_COMMAND_TIMEOUTS.dbWalgCopy ?? 4 * 3_600_000;
  const res = await runSidecar(docker, {
    image: await pullHelper(docker, 'walg', p.engineImage, p.fallbackEngineImage, p.registryAuth),
    entrypoint: ['/bin/sh', '-c'],
    args: [walgCopyScript()],
    env,
    binds: [],
    ...physicalNetworks({ resticNetwork: p.resticNetwork }),
    timeout: { ms: Math.max(30_000, budget - 60_000), what: 'wal-g copy' },
  });
  if (res.exitCode !== 0) throw new Error(stderrTail(res.stderr, `wal-g copy exited ${res.exitCode}`));
  return parseCopyOutput(res.stdout, new Date(now()).toISOString());
}
