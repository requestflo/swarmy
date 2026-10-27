/**
 * wal-g point-in-time restore into a managed Postgres member's data volume
 * (QA-087). The controller stops the target first, and this is the part that
 * runs where the data is.
 *
 *   1. Wait until no running container mounts the data volume, so a live
 *      server is never touched.
 *   2. Choose the base backup: the newest one that FINISHED before the target
 *      time. `LATEST` may be after it, and then recovery cannot reach the target.
 *   3. One sidecar with the server's own paths runs {@link walgPitrRestoreScript}:
 *      move PGDATA aside (kept), backup-fetch, prefetch the archived WAL into
 *      the volume, stage `recovery.signal` and the recovery settings. If
 *      anything fails, the trap puts the original PGDATA back.
 *
 * WAL is prefetched, not fetched by the server, because the Postgres image
 * has no wal-g, no S3 credentials and no route to the destination. Its
 * `restore_command` is a plain `cp` from `<data root>/pitr-wal`. The
 * credentials stay in this sidecar's env only.
 *
 * `rollback` ({@link WALG_PITR_ROLLBACK_SCRIPT}) puts the aside copy back
 * when the restored server does not recover (the controller decides that).
 */
import { helperImage } from '@swarmy/core/protocol';
import type { DbRestorePayload, DbRestoreResult } from '@swarmy/core/protocol';
import type { RestoreReporter } from './restore-progress';
import type { DockerClient } from '@swarmy/core/docker';
import {
  S3_PREFLIGHT,
  assertIsoTime,
  assertSnapshotRef,
  assertVolumeName,
  physicalEnv,
  physicalNetworks,
  physicalSidecarTimeoutMs,
  resolvePgDataLayout,
  runSidecar,
  stderrTail,
} from './backup';

/** How long the target's server may take to go away after the controller scaled it to 0. */
export const VOLUME_IDLE_TIMEOUT_MS = 180_000;
const VOLUME_IDLE_POLL_MS = 2_000;

/** The directory (next to PGDATA, on the data volume) the prefetched WAL lands in. */
export const PITR_WAL_DIR = 'pitr-wal';

/**
 * PURE: the restore sidecar script. Every input is container env, validated
 * agent-side: `PGDATA`, `SWARMY_BACKUP_NAME`, `SWARMY_PITR_STAMP`, optional
 * `SWARMY_TARGET_TIME`, and the wal-g S3 env. Runs as root in the wal-g image
 * (Debian: coreutils + awk).
 *
 * Safety: nothing is removed until the original PGDATA has been moved aside,
 * and the EXIT trap undoes a failed run by removing only what this run
 * created and moving the original back.
 */
export function walgPitrRestoreScript(): string {
  // A function, not a constant: backup.ts and this module import each other.
  return [
  'set -eu',
  S3_PREFLIGHT.trim(),
  'ROOT="$(dirname "$PGDATA")"',
  'ASIDE="$PGDATA.pre-pitr-$SWARMY_PITR_STAMP"',
  `WALDIR="$ROOT/${PITR_WAL_DIR}"`,
  'MOVED=0; STARTED=0; PROG=""',
  // SWARMY_PROGRESS=1: PGDATA's size every 5 s while the base backup lands, then WAL counts.
  'stop_progress() { if [ -n "$PROG" ]; then kill "$PROG" 2>/dev/null || true; PROG=""; fi; }',
  'rollback() {',
  '  echo "swarmy: PITR restore failed - putting the original PGDATA back" >&2',
  '  if [ "$STARTED" = 1 ]; then rm -rf "$PGDATA" "$WALDIR"; fi',
  '  if [ "$MOVED" = 1 ]; then mv "$ASIDE" "$PGDATA"; fi',
  '}',
  'trap \'rc=$?; stop_progress; if [ "$rc" != 0 ]; then rollback; fi; exit "$rc"\' EXIT',
  'if [ -e "$ASIDE" ]; then echo "swarmy: $ASIDE already exists - refusing to overwrite a kept copy" >&2; exit 4; fi',
  'OWNER="$(stat -c %u:%g "$PGDATA" 2>/dev/null || echo 999:999)"',
  // 1) keep the original: moved aside, never deleted.
  'if [ -e "$PGDATA" ]; then mv "$PGDATA" "$ASIDE"; MOVED=1; echo "swarmy: kept the previous PGDATA at $ASIDE"; fi',
  'STARTED=1',
  'rm -rf "$WALDIR"',
  'mkdir -p "$PGDATA" "$WALDIR"; chmod 700 "$PGDATA"',
  // 2) the base backup.
  'if [ "${SWARMY_PROGRESS:-}" = 1 ]; then',
  '  ( while :; do sleep 5 </dev/null >/dev/null 2>&1; echo "swarmy: progress base $(du -sb "$PGDATA" 2>/dev/null | cut -f1)"; done ) &',
  '  PROG=$!',
  'fi',
  'wal-g backup-fetch "$PGDATA" "$SWARMY_BACKUP_NAME"',
  'stop_progress',
  'if [ "${SWARMY_PROGRESS:-}" = 1 ]; then echo "swarmy: progress base $(du -sb "$PGDATA" 2>/dev/null | cut -f1)"; echo "swarmy: progress wal 0"; fi',
  // 3) the archived WAL from the backup's start on, following timeline switches.
  'START="$(sed -n \'s/^START WAL LOCATION: .*(file \\([0-9A-F]\\{24\\}\\)).*$/\\1/p\' "$PGDATA/backup_label" | head -n 1)"',
  'if [ -z "$START" ]; then echo "swarmy: the base backup has no backup_label START WAL LOCATION" >&2; exit 5; fi',
  'TLI=$((0x$(echo "$START" | cut -c1-8)))',
  'NO=$(( 0x$(echo "$START" | cut -c9-16) * 256 + 0x$(echo "$START" | cut -c17-24) ))',
  'seg() { printf "%08X%08X%08X" "$1" $(( $2 / 256 )) $(( $2 % 256 )); }',
  // A missing object ends the archive; any other wal-g error fails the restore.
  'fetch() {',
  '  if OUT="$(wal-g wal-fetch "$1" "$WALDIR/$1" 2>&1)"; then return 0; fi',
  '  case "$OUT" in *"does not exist"*) return 1 ;; esac',
  '  echo "$OUT" >&2; echo "swarmy: wal-g wal-fetch $1 failed" >&2; exit 6',
  '}',
  'N=0; LAST=none',
  'while :; do',
  '  S="$(seg "$TLI" "$NO")"',
  '  if fetch "$S"; then',
  '    N=$((N + 1)); LAST="$S"; NO=$((NO + 1))',
  '    if [ "${SWARMY_PROGRESS:-}" = 1 ] && [ $((N % 16)) = 0 ]; then echo "swarmy: progress wal $N"; fi',
  '    continue',
  '  fi',
  '  NEXT=$((TLI + 1)); H="$(printf "%08X" "$NEXT").history"',
  '  if fetch "$H"; then',
  // The new timeline branches at the LAST switch point its history file lists.
  '    LSN="$(awk \'$1 ~ /^[0-9]+$/ && NF >= 2 { l = $2 } END { print l }\' "$WALDIR/$H")"',
  '    HI="${LSN%%/*}"; LO="${LSN#*/}"',
  '    NO=$(( 0x$HI * 256 + 0x$LO / 16777216 )); TLI=$NEXT',
  '    echo "swarmy: following timeline $TLI from $(seg "$TLI" "$NO")"',
  '    continue',
  '  fi',
  '  break',
  'done',
  'echo "swarmy: fetched $N WAL segments (last $LAST)"',
  // 4) recovery: replay from the local copy up to the target, then promote.
  '{',
  '  printf "\\n# swarmy PITR restore (removed after promotion)\\n"',
  '  printf "restore_command = \'cp %s/%%f %%p\'\\n" "$WALDIR"',
  '  printf "recovery_target_timeline = \'latest\'\\n"',
  '  if [ -n "${SWARMY_TARGET_TIME:-}" ]; then',
  '    printf "recovery_target_time = \'%s\'\\n" "$SWARMY_TARGET_TIME"',
  '    printf "recovery_target_action = \'promote\'\\n"',
  '  fi',
  '} >> "$PGDATA/postgresql.auto.conf"',
  'touch "$PGDATA/recovery.signal"',
  'chown -R "$OWNER" "$PGDATA" "$WALDIR"; chmod 700 "$PGDATA"',
  'MOVED=0; STARTED=0',
  'echo "swarmy: staged recovery of $SWARMY_BACKUP_NAME${SWARMY_TARGET_TIME:+ to $SWARMY_TARGET_TIME}"',
  ].join('\n');
}

/** PURE: put the kept copy back in place of a restore that did not recover. */
export const WALG_PITR_ROLLBACK_SCRIPT = [
  'set -eu',
  'ROOT="$(dirname "$PGDATA")"',
  'ASIDE="$PGDATA.pre-pitr-$SWARMY_PITR_STAMP"',
  'if [ ! -e "$ASIDE" ]; then echo "swarmy: no kept copy at $ASIDE - nothing to roll back to" >&2; exit 4; fi',
  `rm -rf "$PGDATA" "$ROOT/${PITR_WAL_DIR}"`,
  'mv "$ASIDE" "$PGDATA"',
  'echo "swarmy: put the pre-restore PGDATA back from $ASIDE"',
].join('\n');

/** One row of `wal-g backup-list --json --detail` (the fields used here). */
interface WalgBackupRow {
  backup_name?: string;
  time?: string;
  start_time?: string;
  finish_time?: string;
}

/**
 * PURE: the base backup to restore. An explicit name wins. Without a target
 * time it is `LATEST`. With one, it is the newest backup that FINISHED at or
 * before the target, since recovery cannot stop before a backup's end.
 */
export function pickBaseBackup(listJson: string, snapshotId: string | undefined, targetTime: string | undefined): string {
  if (snapshotId && snapshotId.toLowerCase() !== 'latest') return assertSnapshotRef(snapshotId);
  if (!targetTime) return 'LATEST';
  let rows: WalgBackupRow[];
  try {
    const v = JSON.parse(listJson) as unknown;
    rows = Array.isArray(v) ? (v as WalgBackupRow[]) : [];
  } catch {
    throw new Error('could not read the wal-g backup list');
  }
  const target = Date.parse(targetTime);
  const finished = rows
    .map((r) => ({ name: r.backup_name, end: Date.parse(r.finish_time ?? r.time ?? '') }))
    .filter((r): r is { name: string; end: number } => Boolean(r.name) && Number.isFinite(r.end))
    .sort((a, b) => b.end - a.end);
  const eligible = finished.filter((r) => r.end <= target);
  if (eligible.length === 0) {
    const oldest = finished[finished.length - 1];
    throw new Error(
      oldest
        ? `no base backup finished before ${targetTime}. The recoverable window starts at ${new Date(oldest.end).toISOString()} (when the oldest base backup, ${oldest.name}, finished) and runs to the newest archived change - pick a time in it`
        : `no base backup finished before ${targetTime}: there are no base backups yet, so there is no recoverable window - take a base backup first`,
    );
  }
  return assertSnapshotRef(eligible[0]!.name);
}

/**
 * PURE: a base backup's size on disk (`uncompressed_size` in
 * `wal-g backup-list --json --detail`); `LATEST` is the newest one.
 * Undefined when the list does not say.
 */
export function baseBackupSize(listJson: string, name: string): number | undefined {
  let rows: Array<WalgBackupRow & { uncompressed_size?: unknown }>;
  try {
    const v = JSON.parse(listJson) as unknown;
    rows = Array.isArray(v) ? (v as typeof rows) : [];
  } catch {
    return undefined;
  }
  const row =
    name === 'LATEST'
      ? [...rows].sort((a, b) => Date.parse(b.finish_time ?? b.time ?? '') - Date.parse(a.finish_time ?? a.time ?? ''))[0]
      : rows.find((r) => r.backup_name === name);
  const n = Number(row?.uncompressed_size);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** Wait until no RUNNING container on this node mounts `volume`. */
export async function waitVolumeIdle(
  docker: DockerClient,
  volume: string,
  timeoutMs = VOLUME_IDLE_TIMEOUT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const users = (await docker.docker.listContainers({ filters: { volume: [volume] } })) as Array<{ Names?: string[] }>;
    if (users.length === 0) return;
    if (Date.now() >= deadline) {
      const names = users.map((u) => (u.Names?.[0] ?? '').replace(/^\//, '')).join(', ');
      throw new Error(`the data volume ${volume} is still in use by ${names} - stop the target before a PITR restore`);
    }
    await sleep(VOLUME_IDLE_POLL_MS);
  }
}

/** The wal-g PITR restore (or rollback) on this node. */
export async function restoreWalgPitr(
  docker: DockerClient,
  p: DbRestorePayload,
  started: number,
  onLine: (line: string) => void,
  opts: { idleTimeoutMs?: number; sleep?: (ms: number) => Promise<void>; progress?: RestoreReporter | null } = {},
): Promise<DbRestoreResult> {
  if (!p.dataVolume) throw new Error('pitr restore requires the target PGDATA volume (dataVolume) to be set');
  if (!p.pitrStamp) throw new Error('pitr restore requires a pitrStamp (the controller names the kept copy)');
  const dataVolume = assertVolumeName(p.dataVolume);
  const layout = await resolvePgDataLayout(docker, p.conn.host, dataVolume);
  await waitVolumeIdle(docker, dataVolume, opts.idleTimeoutMs, opts.sleep);

  const { env } = physicalEnv(p.repo);
  const image = helperImage('walg', p.engineImage);
  const base = {
    image,
    entrypoint: ['/bin/sh', '-c'],
    binds: [`${dataVolume}:${layout.mountTarget}`],
    ...physicalNetworks(p),
  };
  const stampEnv = [`PGDATA=${layout.pgdata}`, `SWARMY_PITR_STAMP=${p.pitrStamp}`];

  if (p.pitrAction === 'rollback') {
    const res = await runSidecar(docker, { ...base, args: [WALG_PITR_ROLLBACK_SCRIPT], env: stampEnv, networkMode: undefined, networks: undefined }, onLine);
    if (res.exitCode !== 0) throw new Error(stderrTail(res.stderr, `pitr rollback exited ${res.exitCode}`));
    return { mode: p.mode, engine: p.engine, bytesRestored: 0, durationMs: Date.now() - started };
  }

  const target = p.targetTime ? assertIsoTime(p.targetTime) : undefined;
  const progress = opts.progress ?? null;
  let backupName = pickBaseBackup('[]', p.snapshotId, undefined);
  let bytesTotal: number | undefined;
  // The list picks the base backup for a target time, and gives its size for progress.
  if ((target && (!p.snapshotId || p.snapshotId.toLowerCase() === 'latest')) || progress) {
    const list = await runSidecar(
      docker,
      {
        ...base,
        binds: [],
        args: [`set -e; ${S3_PREFLIGHT}wal-g backup-list --json --detail`],
        env,
        timeout: { ms: 300_000, what: 'wal-g backup-list' },
      },
      onLine,
    );
    if (list.exitCode !== 0) throw new Error(stderrTail(list.stderr, `wal-g backup-list exited ${list.exitCode}`));
    backupName = pickBaseBackup(list.stdout, p.snapshotId, target);
    bytesTotal = baseBackupSize(list.stdout, backupName);
  }
  progress?.stage('base', bytesTotal != null ? { bytesTotal } : {});

  const res = await runSidecar(
    docker,
    {
      ...base,
      args: [walgPitrRestoreScript()],
      env: [
        ...env,
        ...stampEnv,
        `SWARMY_BACKUP_NAME=${backupName}`,
        ...(target ? [`SWARMY_TARGET_TIME=${target}`] : []),
        ...(progress ? ['SWARMY_PROGRESS=1'] : []),
      ],
      timeout: { ms: physicalSidecarTimeoutMs(p.timeoutMs, 'dbRestore'), what: 'wal-g PITR restore' },
    },
    onLine,
  );
  if (res.exitCode !== 0) throw new Error(stderrTail(res.stderr, `wal-g PITR restore exited ${res.exitCode}`));
  const kept = /kept the previous PGDATA at (\S+)/.exec(res.stdout)?.[1];
  return {
    mode: p.mode,
    engine: p.engine,
    bytesRestored: 0,
    recoveredTo: target,
    backupName,
    ...(kept ? { asidePath: kept } : {}),
    durationMs: Date.now() - started,
  };
}
