/**
 * Moving a volume between servers (plans/epic-volume-mobility.md, phase 2) —
 * the PURE half: the shell the mover containers run, the parsers for what
 * they print, the manifest compare, the re-pin transform and the label codecs.
 *
 * How a move runs (the IO lives in `@swarmy/trpc` volumeMove.service):
 *
 *   serve    a short-lived swarm SERVICE `swarmy-move-<id>` pinned to the
 *            source node, mounting each volume READ-ONLY and running an rsync
 *            daemon on the `swarmy` overlay. Its password is a Docker secret
 *            (never an env var, never a file on the node's disk — the daemon's
 *            secrets file is built in /dev/shm inside the container).
 *   pull     a `container.runOnce` on the destination that rsyncs each volume
 *            (live pass, then the final pass with the app scaled to 0).
 *            Password as container env only (RSYNC_PASSWORD), like restic's.
 *   verify   a `container.runOnce` on EACH side prints a manifest (file,
 *            link and dir counts, byte total, sha256 over every file and
 *            link target); the two must be identical.
 *
 * Every script is fixed text + validated names — nothing from a user is
 * interpolated unquoted.
 */

/** Mover image; rsync is installed on start when missing. */
export const MOVER_IMAGE = 'alpine:3.20';
/** rsync daemon port on the overlay (never published). */
export const MOVER_RSYNC_PORT = 8730;
/** A serve service that outlives this is stopped by its own timeout. */
export const MOVER_SERVE_MAX_SECONDS = 12 * 60 * 60;
/** Where the serve container mounts volume `<name>` (read-only). */
export const MOVER_SRC_ROOT = '/src';
/** Where the pull / manifest containers mount the volume. */
export const MOVER_DST = '/dst';
/** In-container path of the rsync password secret. */
export const MOVER_SECRET_TARGET = 'swarmy-move-secret';

/** Service label while a move runs: JSON {@link MoveState}. Reconcile workers leave the service alone. */
export const MOVE_STATE_LABEL = 'swarmy.move.state';
/** Service label listing old copies kept after moves: JSON {@link OldCopy}[]. */
export const MOVE_OLD_COPIES_LABEL = 'swarmy.move.oldCopies';
/** Days an old copy is kept before the owner is prompted (never auto-deleted). */
export const OLD_COPY_KEEP_DAYS = 7;
/**
 * Primary label for a PLANNED Postgres switchover: `<iso time>`. With the
 * primary stopped on purpose, the manageddb-reconcile worker skips the grace
 * window (and the "primary unhealthy" alert) — the promotion still goes through
 * `decideFailover`, so a replica that is not provably caught up still holds.
 */
export const DB_SWITCHOVER_LABEL = 'swarmy.db.switchover';
/** A switchover request older than this is ignored (a crashed run must not skip grace forever). */
export const DB_SWITCHOVER_MAX_AGE_MS = 10 * 60_000;

const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const HOST_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

export function isValidVolumeName(name: string): boolean {
  return VOLUME_NAME_RE.test(name);
}

function assertVolume(name: string): void {
  if (!isValidVolumeName(name)) throw new Error(`invalid volume name "${name}"`);
}

/** `swarmy-move-<id>` — the serve service (also its overlay DNS name). */
export function moverServiceName(moveId: string): string {
  return `swarmy-move-${moveId}`;
}
export function moverSecretName(moveId: string): string {
  return `swarmy-move-${moveId}-secret`;
}

/** A move id: short, DNS-safe. */
export function newMoveId(now: number, rand: () => number = Math.random): string {
  const r = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
  return `${now.toString(36)}${r}`.toLowerCase();
}

const ENSURE_RSYNC = 'command -v rsync >/dev/null 2>&1 || apk add --no-cache rsync >/dev/null';

/** The serve container's script: an rsync daemon, one read-only module per volume. */
export function serveScript(volumes: readonly string[]): string {
  volumes.forEach(assertVolume);
  const modules = volumes
    .map((v) => `[${v}]\\n  path = ${MOVER_SRC_ROOT}/${v}\\n  read only = yes\\n`)
    .join('');
  return [
    'set -eu',
    ENSURE_RSYNC,
    'umask 077',
    `printf 'swarmy:%s\\n' "$(cat /run/secrets/${MOVER_SECRET_TARGET})" > /dev/shm/rsyncd.secrets`,
    `printf 'uid = 0\\ngid = 0\\nuse chroot = no\\nnumeric ids = yes\\nauth users = swarmy\\nsecrets file = /dev/shm/rsyncd.secrets\\nstrict modes = yes\\nmax connections = 4\\n${modules}' > /dev/shm/rsyncd.conf`,
    `exec timeout ${MOVER_SERVE_MAX_SECONDS} rsync --daemon --no-detach --port=${MOVER_RSYNC_PORT} --config=/dev/shm/rsyncd.conf`,
  ].join('\n');
}

/**
 * The pull script. `final=false` is the live pass: files vanishing mid-copy
 * (exit 24) are fine. Connection errors retry while the serve task starts.
 * `requireEmpty` refuses a destination that already holds data (first pass).
 */
export function pullScript(opts: { host: string; volume: string; final: boolean; requireEmpty: boolean; bwlimitKbps?: number }): string {
  assertVolume(opts.volume);
  if (!HOST_RE.test(opts.host)) throw new Error(`invalid mover host "${opts.host}"`);
  const bw = opts.bwlimitKbps && opts.bwlimitKbps > 0 ? ` --bwlimit=${Math.floor(opts.bwlimitKbps)}` : '';
  return [
    'set -u',
    ENSURE_RSYNC,
    opts.requireEmpty
      ? `if [ -n "$(ls -A ${MOVER_DST} 2>/dev/null)" ]; then echo 'SWARMY_DEST_NOT_EMPTY'; exit 42; fi`
      : ':',
    'i=0',
    'while :; do',
    `  rsync -aH --numeric-ids --delete --stats --timeout=600${bw} "rsync://swarmy@${opts.host}:${MOVER_RSYNC_PORT}/${opts.volume}/" ${MOVER_DST}/`,
    '  rc=$?',
    '  case $rc in 5|10|35) i=$((i+1)); [ $i -lt 30 ] && { sleep 2; continue; } ;; esac',
    '  break',
    'done',
    opts.final ? ':' : '[ $rc -eq 24 ] && rc=0',
    'echo "SWARMY_RSYNC_EXIT=$rc"',
    'exit $rc',
  ].join('\n');
}

/** Prints `FILES= LINKS= DIRS= BYTES= DIGEST=` for the volume at {@link MOVER_DST}. */
export function manifestScript(checksum = true): string {
  return [
    'set -eu',
    `cd ${MOVER_DST}`,
    'export LC_ALL=C',
    "echo \"FILES=$(find . -type f | wc -l | tr -d ' ')\"",
    "echo \"LINKS=$(find . -type l | wc -l | tr -d ' ')\"",
    "echo \"DIRS=$(find . -type d | wc -l | tr -d ' ')\"",
    "echo \"BYTES=$(find . -type f -exec stat -c %s {} + | awk '{s+=$1} END {printf \"%d\", s}')\"",
    checksum
      ? "echo \"DIGEST=$({ find . -type f -print0 | sort -z | xargs -0 -r sha256sum; find . -type l -exec sh -c 'for l; do printf \"%s>%s\\n\" \"$l\" \"$(readlink \"$l\")\"; done' _ {} + | sort; } | sha256sum | cut -d' ' -f1)\""
      : 'echo DIGEST=skipped',
  ].join('\n');
}

export interface VolumeManifest {
  files: number;
  links: number;
  dirs: number;
  bytes: number;
  digest: string;
}

export function parseManifest(output: string): VolumeManifest | null {
  const get = (k: string) => new RegExp(`^${k}=(\\S+)$`, 'm').exec(output)?.[1];
  const files = Number(get('FILES'));
  const links = Number(get('LINKS'));
  const dirs = Number(get('DIRS'));
  const bytes = Number(get('BYTES'));
  const digest = get('DIGEST');
  if (![files, links, dirs, bytes].every(Number.isFinite) || !digest) return null;
  return { files, links, dirs, bytes, digest };
}

/** Plain-words mismatch, or null when identical. */
export function compareManifests(source: VolumeManifest, dest: VolumeManifest): string | null {
  if (source.files !== dest.files) return `file count differs (${source.files} here, ${dest.files} there)`;
  if (source.links !== dest.links) return `symlink count differs (${source.links} vs ${dest.links})`;
  if (source.dirs !== dest.dirs) return `folder count differs (${source.dirs} vs ${dest.dirs})`;
  if (source.bytes !== dest.bytes) return `size differs (${source.bytes} vs ${dest.bytes} bytes)`;
  if (source.digest !== dest.digest) return 'contents differ (checksums do not match)';
  return null;
}

export interface RsyncStats {
  exit: number | null;
  files?: number;
  transferredBytes?: number;
  totalBytes?: number;
  destNotEmpty: boolean;
}

/** Parse `rsync --stats` + our exit marker. */
export function parseRsyncStats(output: string): RsyncStats {
  const num = (re: RegExp) => {
    const m = re.exec(output)?.[1];
    return m === undefined ? undefined : Number(m.replace(/[,.](?=\d{3}\b)/g, ''));
  };
  const exit = /SWARMY_RSYNC_EXIT=(\d+)/.exec(output)?.[1];
  return {
    exit: exit === undefined ? null : Number(exit),
    files: num(/Number of files:\s*([\d,.]+)/),
    transferredBytes: num(/Total transferred file size:\s*([\d,.]+)/),
    totalBytes: num(/Total file size:\s*([\d,.]+)/),
    destNotEmpty: output.includes('SWARMY_DEST_NOT_EMPTY'),
  };
}

// ── placement + labels ─────────────────────────────────────────────────────

type PlacementLike = { constraints?: string[]; preferences?: string[]; maxReplicasPerNode?: number };

/**
 * Point a service at a new node: every `node.id==` / `node.hostname==`
 * constraint is replaced by `node.id==<dest>` (region/label constraints are
 * kept), and every pin label the service carries is re-pointed. Pure.
 */
export function repinSpec<S extends { placement?: PlacementLike; labels?: Record<string, string> }>(
  spec: S,
  destSwarmNodeId: string,
  pinLabels: readonly string[],
): S {
  const kept = (spec.placement?.constraints ?? []).filter((c) => !/^node\.(id|hostname)\s*[!=]=/.test(c));
  const labels = { ...(spec.labels ?? {}) };
  for (const k of pinLabels) if (labels[k] !== undefined) labels[k] = destSwarmNodeId;
  return {
    ...spec,
    labels,
    placement: { ...(spec.placement ?? {}), constraints: [...kept, `node.id==${destSwarmNodeId}`] },
  };
}

export type MoveStep = 'serve' | 'copy-live' | 'stop' | 'copy-final' | 'verify' | 'repin' | 'start' | 'done';

export interface MoveState {
  id: string;
  step: MoveStep;
  /** Controller node ids. */
  from: string;
  to: string;
  volumes: string[];
  /** Replicas to restore. */
  replicas: number;
  startedAt: string;
}

export interface OldCopy {
  /** Controller node id holding the old copy. */
  nodeId: string;
  volume: string;
  movedAt: string;
  /** When the owner is prompted (never auto-deleted). */
  promptAt: string;
}

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parseMoveState(raw: string | undefined): MoveState | null {
  const s = parseJson<MoveState>(raw);
  return s && typeof s.id === 'string' && typeof s.step === 'string' ? s : null;
}

export function parseOldCopies(raw: string | undefined): OldCopy[] {
  const v = parseJson<unknown>(raw);
  return Array.isArray(v)
    ? v.filter((c): c is OldCopy => Boolean(c) && typeof (c as OldCopy).volume === 'string' && typeof (c as OldCopy).nodeId === 'string')
    : [];
}

/** Add copies (deduped by node+volume), newest wins. */
export function addOldCopies(raw: string | undefined, add: readonly OldCopy[]): string {
  const key = (c: OldCopy) => `${c.nodeId}/${c.volume}`;
  const map = new Map(parseOldCopies(raw).map((c) => [key(c), c] as const));
  for (const c of add) map.set(key(c), c);
  return JSON.stringify([...map.values()]);
}

export function oldCopy(nodeId: string, volume: string, now: number): OldCopy {
  return {
    nodeId,
    volume,
    movedAt: new Date(now).toISOString(),
    promptAt: new Date(now + OLD_COPY_KEEP_DAYS * 86_400_000).toISOString(),
  };
}

/** Old copies whose keep window is over — the owner is asked, never auto-deleted. */
export function oldCopiesDue(raw: string | undefined, now: number): OldCopy[] {
  return parseOldCopies(raw).filter((c) => Date.parse(c.promptAt) <= now);
}

/** Is a planned switchover requested (and fresh) on this primary? */
export function switchoverRequested(labels: Record<string, string> | undefined, now: number): boolean {
  const at = Date.parse(labels?.[DB_SWITCHOVER_LABEL] ?? '');
  return Number.isFinite(at) && now - at >= 0 && now - at <= DB_SWITCHOVER_MAX_AGE_MS;
}
