/**
 * Backup/restore handlers (epic: volumes-dr, P1 backup primitive).
 *
 * The agent runs `restic` as a short-lived sidecar container (no daemon), with
 * the target Docker volume bind-mounted and the repo credentials supplied as
 * env. Repo password + S3 creds arrive over the authenticated WS and are only
 * ever process env inside the container — never written to disk on the node.
 *
 * Wire types live in `@swarmy/core/protocol` (`backup.ts`). Results are reported
 * through the existing `commandResult` path; progress lines stream via `logChunk`.
 */
import { MANAGED_PG_PGDATA, MANAGED_PG_ROOT } from '@swarmy/core';
import type { DockerClient } from '@swarmy/core/docker';
import type {
  BackupVolumePayload,
  DbBackupPayload,
  DbBackupResult,
  DbConnection,
  DbRestorePayload,
  DbRestoreResult,
  ListSnapshotsPayload,
  ResticRepo,
  ResticSnapshotInfo,
  RestoreVolumePayload,
  RetentionOutcome,
} from '@swarmy/core/protocol';
import {
  CONTAINER_PATH_RE,
  DB_NAME_RE,
  DOCKER_VOLUME_NAME_RE,
  ISO_TIMESTAMP_RE,
  SNAPSHOT_REF_RE,
  DEFAULT_PG_CLIENT_IMAGE,
  DEFAULT_PGBACKREST_IMAGE,
  DEFAULT_RESTIC_IMAGE,
  DEFAULT_WALG_IMAGE,
  isPhysicalEngine,
} from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';

/** Where the volume is mounted inside the restic container. */
const MOUNT = '/data';
/** Where the logical dump is staged (scratch volume) inside the db sidecars. */
const DUMP_MOUNT = '/backup';
/** Postgres image default PGDATA when a member's env sets none. */
const IMAGE_DEFAULT_PGDATA = '/var/lib/postgresql/data';
/** Label Swarm stamps on every task container: the owning service's name. */
const SWARM_SERVICE_NAME_LABEL = 'com.docker.swarm.service.name';

// ── payload guards (defense in depth behind the protocol schemas) ────────────
// Every bind below is built from a payload field. The wire schema already
// restricts these, but a volume "name" starting with `/` is a HOST bind, so
// re-check right where the `Binds` string is assembled.

function guard(re: RegExp, what: string, v: string): string {
  if (!re.test(v)) throw new Error(`refusing unsafe ${what}: ${JSON.stringify(v.slice(0, 80))}`);
  return v;
}
/** A Docker NAMED volume — never a host path, never `name:opts`. */
export const assertVolumeName = (v: string): string => guard(DOCKER_VOLUME_NAME_RE, 'volume name', v);
/** An absolute in-container path with no `:` and no `..`. */
export const assertContainerPath = (v: string): string => guard(CONTAINER_PATH_RE, 'container path', v);
/** restic id / `latest` / wal-g backup name — no leading `-`, no shell metachars. */
export const assertSnapshotRef = (v: string): string => guard(SNAPSHOT_REF_RE, 'snapshot id', v);
export const assertDbName = (v: string): string => guard(DB_NAME_RE, 'database name', v);
export const assertIsoTime = (v: string): string => guard(ISO_TIMESTAMP_RE, 'recovery target time', v);

/** POSIX single-quote a value for a `sh -c` script. */
export function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

interface RunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Host bind a node-path repo needs: restic runs in a throwaway sidecar, so the
 * repo dir must be the host's, or every snapshot dies with the container.
 * Docker creates a missing host dir on bind.
 */
export function repoBinds(repo: ResticRepo): string[] {
  return repo.kind === 'node' ? [`${repo.repo}:${repo.repo}`] : [];
}

/** Build the env array (`KEY=VALUE`) restic needs for the repo. */
export function repoEnv(repo: ResticRepo): string[] {
  const env = [`RESTIC_REPOSITORY=${repo.repo}`, `RESTIC_PASSWORD=${repo.password}`];
  if (repo.accessKeyId) env.push(`AWS_ACCESS_KEY_ID=${repo.accessKeyId}`);
  if (repo.secretAccessKey) env.push(`AWS_SECRET_ACCESS_KEY=${repo.secretAccessKey}`);
  if (repo.region) env.push(`AWS_DEFAULT_REGION=${repo.region}`);
  return env;
}

/**
 * Run a one-shot sidecar container and collect its output. `binds` are docker
 * `Binds` entries (e.g. `volname:/data:ro`); `networkMode` attaches the container
 * to an overlay network (e.g. a managed-db cluster net) so it can resolve service
 * DNS names. The container is auto-removed. Used by both the restic and the DB
 * engines — credentials only ever exist as `env` here, never on disk.
 */
export async function runSidecar(
  docker: DockerClient,
  opts: {
    image: string;
    args: string[];
    env: string[];
    binds: string[];
    networkMode?: string;
    /** Override the image ENTRYPOINT (e.g. ['/bin/sh','-c']) to run a tool directly. */
    entrypoint?: string[];
    /** Run as this user (e.g. '0:0'): a fresh scratch volume is root-owned. */
    user?: string;
    /** Best-effort pull first (default true). False for a local image id (`sha256:…`). */
    pull?: boolean;
  },
  onLine?: (line: string) => void,
): Promise<RunOutput> {
  const d = docker.docker;
  if (opts.pull !== false) await docker.pullImage(opts.image).catch(() => undefined);

  let stdout = '';
  let stderr = '';
  const chunks = { write: (s: string, isErr: boolean) => (isErr ? (stderr += s) : (stdout += s)) };

  const container = await d.createContainer({
    Image: opts.image,
    ...(opts.user ? { User: opts.user } : {}),
    Cmd: opts.args,
    Env: opts.env,
    ...(opts.entrypoint ? { Entrypoint: opts.entrypoint } : {}),
    HostConfig: { Binds: opts.binds, AutoRemove: false, NetworkMode: opts.networkMode },
    Tty: false,
  });

  try {
    const stream = (await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    })) as unknown as NodeJS.ReadableStream;

    // demux: dockerode exposes modem.demuxStream for non-tty attach
    const out = {
      write: (b: Buffer) => {
        const s = b.toString('utf8');
        chunks.write(s, false);
        if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l);
      },
    } as unknown as NodeJS.WritableStream;
    const err = {
      write: (b: Buffer) => {
        const s = b.toString('utf8');
        chunks.write(s, true);
        if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l);
      },
    } as unknown as NodeJS.WritableStream;
    (d.modem as unknown as {
      demuxStream(s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream): void;
    }).demuxStream(stream, out, err);

    await container.start();
    const status = await container.wait();
    const exitCode = (status as { StatusCode?: number }).StatusCode ?? 0;
    return { exitCode, stdout, stderr };
  } finally {
    // `v`: drop the anonymous volumes an image's own VOLUME lines create (a DB
    // image as a one-shot would otherwise leak one per run). Named binds stay.
    await container.remove({ force: true, v: true }).catch(() => undefined);
  }
}

/** Ensure the restic repo exists (idempotent — `init` no-ops on an existing repo). */
export async function ensureRepo(
  docker: DockerClient,
  image: string,
  repo: ResticRepo,
  networkMode?: string,
): Promise<void> {
  await runSidecar(docker, {
    image,
    args: ['init'],
    env: repoEnv(repo),
    binds: repoBinds(repo),
    networkMode,
  }).catch(() => undefined);
}

// ── retention (restic forget --keep-within --prune) ──────────────────────────

/**
 * Build the `restic forget` invocation for a retention window, scoped to
 * exactly the snapshots the just-finished backup belongs to. Returns null when
 * no retention was requested — the caller must never prune without an explicit
 * `retentionDays`.
 *
 * Scoping matters: restic treats repeated `--tag` flags as OR, so passing the
 * backup's tags one-per-flag would match (and forget!) every snapshot carrying
 * ANY of them — e.g. every snapshot in the org. All tags are therefore joined
 * into ONE comma-separated `--tag` value (AND semantics), plus `--host` (the
 * same host the backup stamped), mirroring how tightly the snapshot was tagged.
 */
export function forgetArgsFor(p: {
  retentionDays?: number;
  tags: string[];
  host?: string;
}): string[] | null {
  if (p.retentionDays == null) return null;
  const args = ['forget', '--keep-within', `${p.retentionDays}d`, '--prune', '--json'];
  if (p.tags.length > 0) args.push('--tag', p.tags.join(','));
  if (p.host) args.push('--host', p.host);
  return args;
}

/**
 * Count removed snapshots in `restic forget --json` output: an array of groups,
 * each with `keep`/`remove` snapshot lists. `--prune` appends non-JSON prune
 * progress after the array, so scan line-wise for the parseable array.
 */
export function parseForgetRemoved(stdout: string): number {
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('[')) continue;
    try {
      const groups = JSON.parse(t) as Array<{ remove?: unknown }>;
      if (!Array.isArray(groups)) continue;
      return groups.reduce(
        (n, g) => n + (Array.isArray(g.remove) ? g.remove.length : 0),
        0,
      );
    } catch {
      // not the forget summary (e.g. a progress line) — keep scanning
    }
  }
  return 0;
}

/**
 * Enforce a retention window after a SUCCESSFUL backup. Never throws: the
 * backup already succeeded, so a forget/prune failure is reported in the
 * outcome (`error`) rather than failing the command.
 */
export async function applyRetention(
  docker: DockerClient,
  opts: {
    image: string;
    repo: ResticRepo;
    retentionDays: number;
    tags: string[];
    host?: string;
    network?: string;
  },
  onLine?: (line: string) => void,
): Promise<RetentionOutcome> {
  const args = forgetArgsFor(opts);
  if (!args) return { retentionDays: opts.retentionDays, snapshotsRemoved: 0 };
  try {
    const res = await runSidecar(
      docker,
      {
        image: opts.image,
        args,
        env: repoEnv(opts.repo),
        binds: repoBinds(opts.repo),
        networkMode: opts.network,
      },
      onLine,
    );
    if (res.exitCode !== 0) {
      return {
        retentionDays: opts.retentionDays,
        snapshotsRemoved: 0,
        error: res.stderr.trim() || `restic forget exited ${res.exitCode}`,
      };
    }
    return {
      retentionDays: opts.retentionDays,
      snapshotsRemoved: parseForgetRemoved(res.stdout),
    };
  } catch (e) {
    return {
      retentionDays: opts.retentionDays,
      snapshotsRemoved: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function streamer(conn: AgentConnection, commandId: string): (line: string) => void {
  let seq = 0;
  return (line: string) =>
    conn.send('logChunk', { commandId, stream: 'stdout', seq: seq++, data: `${line}\n`, eof: false });
}

export async function backupVolume(
  docker: DockerClient,
  conn: AgentConnection,
  p: BackupVolumePayload,
): Promise<import('@swarmy/core/protocol').BackupVolumeResult> {
  const image = p.image ?? DEFAULT_RESTIC_IMAGE;
  const started = Date.now();
  const onLine = streamer(conn, p.commandId);
  await ensureRepo(docker, image, p.repo, p.network);

  const tagArgs = p.tags.flatMap((t) => ['--tag', t]);
  const res = await runSidecar(
    docker,
    {
      image,
      args: ['backup', MOUNT, '--json', '--host', p.volume, ...tagArgs],
      env: repoEnv(p.repo),
      binds: [`${assertVolumeName(p.volume)}:${MOUNT}:ro`, ...repoBinds(p.repo)],
      networkMode: p.network,
    },
    onLine,
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `restic backup exited ${res.exitCode}`);
  }

  // restic --json emits one summary object on the final line.
  const summary = parseSummary(res.stdout);

  // Enforce retention only AFTER a successful backup; a prune failure is
  // reported in the outcome, never as a command failure.
  const retention =
    p.retentionDays != null
      ? await applyRetention(
          docker,
          {
            image,
            repo: p.repo,
            retentionDays: p.retentionDays,
            tags: p.tags,
            host: p.volume,
            network: p.network,
          },
          onLine,
        )
      : undefined;

  return {
    snapshotId: summary.snapshot_id ?? 'unknown',
    sizeBytes: summary.total_bytes_processed ?? 0,
    filesNew: summary.files_new,
    durationMs: Date.now() - started,
    ...(retention ? { retention } : {}),
  };
}

export async function restoreVolume(
  docker: DockerClient,
  conn: AgentConnection,
  p: RestoreVolumePayload,
): Promise<import('@swarmy/core/protocol').RestoreVolumeResult> {
  const image = p.image ?? DEFAULT_RESTIC_IMAGE;
  const started = Date.now();
  assertVolumeName(p.targetVolume);
  assertSnapshotRef(p.snapshotId);

  // Ensure the destination volume exists (idempotent create).
  await docker.docker.createVolume({ Name: p.targetVolume }).catch(() => undefined);

  const res = await runSidecar(
    docker,
    {
      image,
      // `--target /` because the snapshot stored the absolute mount path (/data).
      args: ['restore', p.snapshotId, '--target', '/', '--json'],
      env: repoEnv(p.repo),
      binds: [`${assertVolumeName(p.targetVolume)}:${MOUNT}`, ...repoBinds(p.repo)],
      networkMode: p.network,
    },
    streamer(conn, p.commandId),
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `restic restore exited ${res.exitCode}`);
  }
  return {
    targetVolume: p.targetVolume,
    bytesRestored: await restoredBytes(docker, res.stdout, {
      image,
      repo: p.repo,
      snapshotId: p.snapshotId,
      network: p.network,
    }),
    durationMs: Date.now() - started,
  };
}

/**
 * Bytes a `restic restore` wrote. restic ≥0.17 ends `--json` with a summary
 * (`bytes_restored` / `total_bytes`), but the pinned 0.16 prints no JSON
 * summary for restore at all, so every restore (restore-as-copy included)
 * reported "0 bytes". Without a summary, ask restic for the snapshot's
 * restore size (`stats --mode restore-size`), which is exactly what a full
 * restore writes. 0 only when both fail.
 */
export async function restoredBytes(
  docker: DockerClient,
  restoreStdout: string,
  q: { image: string; repo: RestoreVolumePayload['repo']; snapshotId: string; network?: string },
): Promise<number> {
  const fromSummary = restoredBytesFromSummary(restoreStdout);
  if (fromSummary !== null) return fromSummary;
  const stats = await runSidecar(docker, {
    image: q.image,
    args: ['stats', q.snapshotId, '--json', '--mode', 'restore-size'],
    env: repoEnv(q.repo),
    binds: repoBinds(q.repo),
    networkMode: q.network,
  }).catch(() => null);
  return (stats && stats.exitCode === 0 ? parseStatsSize(stats.stdout) : null) ?? 0;
}

/** PURE — bytes from a restic ≥0.17 restore summary line, else null. */
export function restoredBytesFromSummary(stdout: string): number | null {
  const lines = stdout.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i] ?? '') as { message_type?: string; bytes_restored?: number; total_bytes?: number };
      if (o.message_type !== 'summary') continue;
      const n = o.bytes_restored ?? o.total_bytes;
      if (typeof n === 'number' && n > 0) return n;
    } catch {
      // non-JSON progress / text output (restic 0.16)
    }
  }
  return null;
}

/** PURE — `restic stats --json` → `total_size`, else null. */
export function parseStatsSize(stdout: string): number | null {
  for (const line of stdout.split('\n').reverse()) {
    try {
      const o = JSON.parse(line) as { total_size?: number };
      if (typeof o.total_size === 'number') return o.total_size;
    } catch {
      // skip
    }
  }
  return null;
}

export async function listSnapshots(
  docker: DockerClient,
  p: ListSnapshotsPayload,
): Promise<{ snapshots: ResticSnapshotInfo[] }> {
  const image = p.image ?? DEFAULT_RESTIC_IMAGE;
  await ensureRepo(docker, image, p.repo, p.network);
  const tagArgs = p.tags.flatMap((t) => ['--tag', t]);
  const res = await runSidecar(docker, {
    image,
    args: ['snapshots', '--json', ...tagArgs],
    env: repoEnv(p.repo),
    binds: repoBinds(p.repo),
    networkMode: p.network,
  });
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `restic snapshots exited ${res.exitCode}`);
  }
  let raw: unknown[] = [];
  try {
    raw = JSON.parse(res.stdout || '[]') as unknown[];
  } catch {
    raw = [];
  }
  const snapshots: ResticSnapshotInfo[] = raw.map((s) => {
    const o = s as Record<string, unknown>;
    return {
      id: String(o.short_id ?? o.id ?? ''),
      time: String(o.time ?? ''),
      hostname: o.hostname ? String(o.hostname) : undefined,
      tags: Array.isArray(o.tags) ? (o.tags as string[]) : [],
      paths: Array.isArray(o.paths) ? (o.paths as string[]) : [],
    };
  });
  return { snapshots };
}

interface ResticSummary {
  message_type?: string;
  snapshot_id?: string;
  total_bytes_processed?: number;
  total_bytes?: number;
  files_new?: number;
}

/** restic streams ndjson; the last `summary`/`restore` object holds the totals. */
export function parseSummary(stdout: string): ResticSummary {
  const lines = stdout.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i] ?? '') as ResticSummary;
      if (o.message_type === 'summary' || o.snapshot_id || o.total_bytes != null) return o;
    } catch {
      // skip non-json progress lines
    }
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// DB-aware engines (logical: pg_dump / pg_dumpall / snapshot-from-replica;
// physical: wal-g / pgbackrest). Each runs as a one-shot sidecar; the DB password
// and S3 creds only ever exist as container env, never on disk or in an image.
// ─────────────────────────────────────────────────────────────────────────────

/** Env shared by every postgres-client sidecar. PGPASSWORD is the only secret. */
export function pgEnv(conn: DbConnection): string[] {
  return [
    `PGPASSWORD=${conn.password}`,
    `DBHOST=${conn.host}`,
    `DBPORT=${conn.port}`,
    `DBUSER=${conn.user}`,
    `DBNAME=${conn.database}`,
  ];
}

/**
 * The libpq connection env a PHYSICAL engine needs to reach the live primary.
 * `wal-g backup-push` / pgbackrest open a replication-capable session to run
 * `pg_backup_start`/`pg_backup_stop` (they do not only read PGDATA), and libpq
 * reads its target from the standard `PG*` variables. Same one-shot contract as
 * {@link pgEnv}: the password rides the authenticated WS and exists only as
 * this sidecar's container env — never a label, a file, argv or a log line.
 */
export function pgConnEnv(conn: DbConnection): string[] {
  return [
    `PGHOST=${conn.host}`,
    `PGPORT=${conn.port}`,
    `PGUSER=${conn.user}`,
    `PGPASSWORD=${conn.password}`,
    `PGDATABASE=${conn.database}`,
  ];
}

/**
 * Where the Postgres SERVER sees its data: the data volume's mount target and
 * PGDATA inside the member container. Physical engines must use exactly these
 * paths. `wal-g backup-push` checks its PGDATA against the server's
 * `data_directory` and refuses a mismatch (QA-074), and a restored base backup
 * must land where the server will look for it.
 */
export interface PgDataLayout {
  /** Mount target of the data volume in the server container. */
  mountTarget: string;
  /** The server's PGDATA (the mount target or a directory under it). */
  pgdata: string;
}

/** What a member container or service spec reports: its mounts and env. */
export interface ObservedPgMember {
  mounts: ReadonlyArray<{ source?: string; target: string }>;
  env: readonly string[];
}

/**
 * PURE: the server's data layout from its observed mounts + env, or null when
 * `dataVolume` is not mounted there. Both paths are validated (they become a
 * bind target and an env value), and a PGDATA outside the data volume is
 * refused: backing that up would copy the wrong directory.
 */
export function pgDataLayoutFrom(observed: ObservedPgMember, dataVolume: string): PgDataLayout | null {
  const mount = observed.mounts.find((m) => m.source === dataVolume);
  if (!mount) return null;
  const mountTarget = assertContainerPath(mount.target.replace(/\/+$/, '') || '/');
  const envPgdata = observed.env.find((e) => e.startsWith('PGDATA='))?.slice('PGDATA='.length);
  const pgdata = assertContainerPath((envPgdata || IMAGE_DEFAULT_PGDATA).replace(/\/+$/, '') || '/');
  if (pgdata !== mountTarget && !pgdata.startsWith(`${mountTarget}/`)) {
    throw new Error(`PGDATA ${pgdata} is not on the data volume ${dataVolume} (mounted at ${mountTarget})`);
  }
  return { mountTarget, pgdata };
}

/** The managed-member layout (@swarmy/core manageddb-pg): the spec every member is built from. */
export const MANAGED_PG_LAYOUT: PgDataLayout = { mountTarget: MANAGED_PG_ROOT, pgdata: MANAGED_PG_PGDATA };

/**
 * Read the live server's data layout for `service`:
 *  1. its task container on THIS node (physical engines run where the data
 *     is, and a worker node cannot inspect services), newest first, stopped
 *     ones included for a restore into a stopped member;
 *  2. the service spec (works on a manager);
 *  3. the managed-member layout every swarmy Postgres spec is built from.
 */
export async function resolvePgDataLayout(
  docker: DockerClient,
  service: string,
  dataVolume: string,
): Promise<PgDataLayout> {
  const d = docker.docker;
  try {
    const list = (await d.listContainers({
      all: true,
      filters: { label: [`${SWARM_SERVICE_NAME_LABEL}=${service}`] },
    })) as Array<{ Id: string; Created?: number }>;
    for (const c of [...list].sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0))) {
      const info = (await d.getContainer(c.Id).inspect()) as {
        Mounts?: Array<{ Name?: string; Source?: string; Destination: string }>;
        Config?: { Env?: string[] };
      };
      const layout = pgDataLayoutFrom(
        {
          mounts: (info.Mounts ?? []).map((m) => ({ source: m.Name ?? m.Source, target: m.Destination })),
          env: info.Config?.Env ?? [],
        },
        dataVolume,
      );
      if (layout) return layout;
    }
  } catch (e) {
    if (e instanceof Error && /refusing unsafe|is not on the data volume/.test(e.message)) throw e;
  }
  try {
    const svc = (await d.getService(service).inspect()) as {
      Spec?: { TaskTemplate?: { ContainerSpec?: { Mounts?: Array<{ Source?: string; Target: string }>; Env?: string[] } } };
    };
    const cs = svc.Spec?.TaskTemplate?.ContainerSpec;
    const layout = pgDataLayoutFrom(
      { mounts: (cs?.Mounts ?? []).map((m) => ({ source: m.Source, target: m.Target })), env: cs?.Env ?? [] },
      dataVolume,
    );
    if (layout) return layout;
  } catch (e) {
    if (e instanceof Error && /refusing unsafe|is not on the data volume/.test(e.message)) throw e;
  }
  return MANAGED_PG_LAYOUT;
}

/** A scratch Docker volume name for staging a logical dump (ephemeral). */
function scratchVolumeName(jobId: string): string {
  return `swarmy-dbdump-${jobId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48) || 'job'}`;
}

/** Parse the S3 coordinates back out of a restic repo URL (`s3:<scheme>//host/bucket/prefix`). */
function parseS3Repo(repo: ResticRepo): { endpoint: string; bucket: string; prefix: string } {
  if (repo.kind !== 's3') {
    throw new Error('physical (wal-g / pgbackrest) backups require an S3 target');
  }
  const rest = repo.repo.replace(/^s3:/, '');
  const u = new URL(rest);
  const segs = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const bucket = segs.shift() ?? '';
  return { endpoint: `${u.protocol}//${u.host}`, bucket, prefix: segs.join('/') };
}

/** Env for wal-g / pgbackrest: S3 coordinates + creds (no secret on disk). */
function physicalEnv(repo: ResticRepo): { env: string[]; bucket: string; endpoint: string; prefix: string } {
  const { endpoint, bucket, prefix } = parseS3Repo(repo);
  const walgPrefix = `s3://${bucket}${prefix ? `/${prefix}` : ''}`;
  const env = [
    `WALG_S3_PREFIX=${walgPrefix}`,
    `AWS_ENDPOINT=${endpoint}`,
    'AWS_S3_FORCE_PATH_STYLE=true',
  ];
  if (repo.accessKeyId) env.push(`AWS_ACCESS_KEY_ID=${repo.accessKeyId}`);
  if (repo.secretAccessKey) env.push(`AWS_SECRET_ACCESS_KEY=${repo.secretAccessKey}`);
  if (repo.region) env.push(`AWS_DEFAULT_REGION=${repo.region}`, `AWS_REGION=${repo.region}`);
  return { env, bucket, endpoint, prefix };
}

/**
 * Back up a managed Postgres cluster with the requested engine.
 *
 * Logical engines stage a dump onto a scratch volume, then store it with restic
 * (so it lands in the same target catalog as volume backups, dedup + encrypted).
 * `snapshot-from-replica` is just a `pg_dump` whose `conn.host` the controller
 * pointed at a read-replica — zero primary load, identical artefact.
 *
 * Physical engines (wal-g / pgbackrest) push a base backup straight to S3 from
 * the primary's PGDATA volume; combined with WAL archiving they enable PITR.
 */
export async function backupDb(
  docker: DockerClient,
  conn: AgentConnection,
  p: DbBackupPayload,
): Promise<DbBackupResult> {
  const started = Date.now();
  const onLine = streamer(conn, p.commandId);
  if (isPhysicalEngine(p.engine)) {
    return backupDbPhysical(docker, p, started, onLine);
  }
  return backupDbLogical(docker, p, started, onLine);
}

async function backupDbLogical(
  docker: DockerClient,
  p: DbBackupPayload,
  started: number,
  onLine: (line: string) => void,
): Promise<DbBackupResult> {
  const clientImage = p.clientImage ?? DEFAULT_PG_CLIENT_IMAGE;
  const resticImage = p.resticImage ?? DEFAULT_RESTIC_IMAGE;
  const scratch = scratchVolumeName(p.jobId);
  await docker.docker.createVolume({ Name: scratch });
  try {
    // 1) Dump onto the scratch volume.
    const dumpAll = p.engine === 'pg_dumpall';
    const file = dumpAll ? `${DUMP_MOUNT}/dump.sql` : `${DUMP_MOUNT}/dump.pgc`;
    const script = dumpAll
      ? `set -e; pg_dumpall -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" --no-password -f ${file}`
      : `set -e; pg_dump -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" -d "$DBNAME" --no-password -Fc -f ${file}`;
    const dump = await runSidecar(
      docker,
      {
        image: clientImage,
        entrypoint: ['/bin/sh', '-c'],
        args: [script],
        env: pgEnv(p.conn),
        binds: [`${scratch}:${DUMP_MOUNT}`],
        networkMode: p.network,
        // Some Postgres client images run as a non-root uid and can't write
        // the fresh, root-owned scratch volume. The dump only talks
        // to the DB over the network, so root in this throwaway container is safe.
        user: '0:0',
      },
      onLine,
    );
    if (dump.exitCode !== 0) {
      throw new Error(dump.stderr.trim() || `${p.engine} exited ${dump.exitCode}`);
    }

    // 2) Store the staged dump with restic into the same target catalog.
    await ensureRepo(docker, resticImage, p.repo, p.resticNetwork);
    const tagArgs = p.tags.flatMap((t) => ['--tag', t]);
    const store = await runSidecar(
      docker,
      {
        image: resticImage,
        args: ['backup', DUMP_MOUNT, '--json', '--host', p.conn.database, ...tagArgs],
        env: repoEnv(p.repo),
        binds: [`${scratch}:${DUMP_MOUNT}:ro`, ...repoBinds(p.repo)],
        networkMode: p.resticNetwork,
      },
      onLine,
    );
    if (store.exitCode !== 0) {
      throw new Error(store.stderr.trim() || `restic backup exited ${store.exitCode}`);
    }
    const summary = parseSummary(store.stdout);

    // Retention runs only after the dump is safely in the repo; scoped to this
    // cluster's tags + host so no other cluster's snapshots can be forgotten.
    const retention =
      p.retentionDays != null
        ? await applyRetention(
            docker,
            {
              image: resticImage,
              repo: p.repo,
              retentionDays: p.retentionDays,
              tags: p.tags,
              host: p.conn.database,
              network: p.resticNetwork,
            },
            onLine,
          )
        : undefined;

    return {
      snapshotId: summary.snapshot_id ?? 'unknown',
      engine: p.engine,
      sizeBytes: summary.total_bytes_processed ?? 0,
      databases: dumpAll ? ['*'] : [p.conn.database],
      durationMs: Date.now() - started,
      ...(retention ? { retention } : {}),
    };
  } finally {
    await docker.docker.getVolume(scratch).remove({ force: true }).catch(() => undefined);
  }
}

async function backupDbPhysical(
  docker: DockerClient,
  p: DbBackupPayload,
  started: number,
  onLine: (line: string) => void,
): Promise<DbBackupResult> {
  if (!p.dataVolume) {
    throw new Error('physical backup requires the primary PGDATA volume (dataVolume) to be set');
  }
  const { env, bucket, endpoint, prefix } = physicalEnv(p.repo);
  const dataVolume = assertVolumeName(p.dataVolume);
  // Same paths as the server (QA-074): wal-g refuses a PGDATA that differs
  // from the server's data_directory.
  const layout = await resolvePgDataLayout(docker, p.conn.host, dataVolume);
  if (p.engine === 'wal-g') {
    const image = p.engineImage ?? DEFAULT_WALG_IMAGE;
    const res = await runSidecar(
      docker,
      {
        image,
        entrypoint: ['/bin/sh', '-c'],
        args: [WALG_BACKUP_SCRIPT],
        env: [...env, ...pgConnEnv(p.conn), `PGDATA=${layout.pgdata}`],
        binds: [`${dataVolume}:${layout.mountTarget}:ro`],
        networkMode: p.network,
      },
      onLine,
    );
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `wal-g backup-push exited ${res.exitCode}`);
    }
    return {
      snapshotId: parseWalgBackupName(res.stdout + res.stderr),
      engine: p.engine,
      sizeBytes: 0,
      databases: ['*'],
      durationMs: Date.now() - started,
    };
  }
  // pgbackrest
  const image = p.engineImage ?? DEFAULT_PGBACKREST_IMAGE;
  const flags = pgBackRestRepoFlags(p.repo, bucket, endpoint, prefix);
  const res = await runSidecar(
    docker,
    {
      image,
      entrypoint: ['/bin/sh', '-c'],
      args: [pgbackrestBackupScript(flags)],
      env: [...env, ...pgConnEnv(p.conn), `PGDATA=${layout.pgdata}`],
      binds: [`${dataVolume}:${layout.mountTarget}`],
      networkMode: p.network,
    },
    onLine,
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `pgbackrest backup exited ${res.exitCode}`);
  }
  return {
    snapshotId: 'pgbackrest:latest',
    engine: p.engine,
    sizeBytes: 0,
    databases: ['*'],
    durationMs: Date.now() - started,
  };
}

export function pgBackRestRepoFlags(repo: ResticRepo, bucket: string, endpoint: string, prefix: string): string {
  const host = endpoint.replace(/^https?:\/\//, '');
  // Every value is shell-quoted: this string is spliced into a `sh -c` script.
  return [
    '--repo1-type=s3',
    `--repo1-s3-bucket=${shq(bucket)}`,
    `--repo1-s3-endpoint=${shq(host)}`,
    `--repo1-s3-region=${shq(repo.region ?? 'us-east-1')}`,
    `--repo1-path=${shq(`/${prefix || 'pgbackrest'}`)}`,
    '--repo1-s3-uri-style=path',
  ].join(' ');
}

// ── restore scripts (pure; every payload value rides as container ENV) ──────
// The scripts are constants modulo booleans and server-derived mount paths, so
// no payload value is ever interpolated into shell. Tested in backup.test.ts.

/** Logical load: `$DBNAME` comes from {@link pgEnv}. */
export function logicalRestoreScript(dumpAll: boolean): string {
  return dumpAll
    ? `set -e; psql -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" --no-password -d postgres -f ${DUMP_MOUNT}/dump.sql`
    : `set -e; pg_restore -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" --no-password -d "$DBNAME" ` +
        `--clean --if-exists --no-owner ${DUMP_MOUNT}/dump.pgc`;
}

// Every physical script reads the server's PGDATA from `$PGDATA` (container env
// resolved by resolvePgDataLayout), so no path is spliced into shell.

/** wal-g base backup of the server's own `$PGDATA`. */
export const WALG_BACKUP_SCRIPT = 'set -e; wal-g backup-push "$PGDATA"';

/** pgbackrest full backup of `$PGDATA`; `flags` from {@link pgBackRestRepoFlags} (quoted). */
export function pgbackrestBackupScript(flags: string): string {
  return (
    `set -e; pgbackrest --stanza=swarmy --pg1-path="$PGDATA" ${flags} stanza-create || true; ` +
    `pgbackrest --stanza=swarmy --pg1-path="$PGDATA" ${flags} --type=full backup`
  );
}

/** wal-g fetch + recovery target into `$PGDATA`: `$SWARMY_BACKUP_NAME`, `$SWARMY_TARGET_TIME`. */
export function walgRestoreScript(withTarget: boolean): string {
  const recoveryConf = withTarget
    ? `printf "recovery_target_time = '%s'\\nrecovery_target_action = 'promote'\\n" "$SWARMY_TARGET_TIME" ` +
      `>> "$PGDATA/postgresql.auto.conf"; touch "$PGDATA/recovery.signal";`
    : '';
  return `set -e; wal-g backup-fetch "$PGDATA" "$SWARMY_BACKUP_NAME"; ${recoveryConf}`;
}

/** pgbackrest restore into `$PGDATA`: `$SWARMY_TARGET_TIME`; `flags` from {@link pgBackRestRepoFlags} (quoted). */
export function pgbackrestRestoreScript(flags: string, withTarget: boolean): string {
  const typeFlag = withTarget ? '--type=time --target="$SWARMY_TARGET_TIME"' : '--type=default';
  return `set -e; pgbackrest --stanza=swarmy --pg1-path="$PGDATA" ${flags} ${typeFlag} --delta restore`;
}

/** The env the PITR scripts read (validated again here — defense in depth). */
export function pitrScriptEnv(p: { snapshotId?: string; targetTime?: string }): string[] {
  const snap = p.snapshotId && p.snapshotId.toLowerCase() !== 'latest' ? assertSnapshotRef(p.snapshotId) : 'LATEST';
  const env = [`SWARMY_BACKUP_NAME=${snap}`];
  if (p.targetTime) env.push(`SWARMY_TARGET_TIME=${assertIsoTime(p.targetTime)}`);
  return env;
}

/** wal-g prints `Wrote backup with name base_…`; fall back to scanning for base_*. */
function parseWalgBackupName(out: string): string {
  const named = out.match(/backup with name\s+(\S+)/i);
  if (named) return named[1]!;
  const base = out.match(/base_[0-9A-Fa-f]+/);
  return base ? base[0] : 'latest';
}

/**
 * Restore a managed Postgres cluster.
 *  - clone-to-new-cluster / in-place / single-database → logical pg_restore/psql
 *    of a dump fetched from restic.
 *  - pitr → physical wal-g/pgbackrest fetch + recovery target staged into PGDATA.
 */
export async function restoreDb(
  docker: DockerClient,
  conn: AgentConnection,
  p: DbRestorePayload,
): Promise<DbRestoreResult> {
  const started = Date.now();
  const onLine = streamer(conn, p.commandId);
  if (p.mode === 'pitr') {
    return restoreDbPitr(docker, p, started, onLine);
  }
  return restoreDbLogical(docker, p, started, onLine);
}

async function restoreDbLogical(
  docker: DockerClient,
  p: DbRestorePayload,
  started: number,
  onLine: (line: string) => void,
): Promise<DbRestoreResult> {
  if (isPhysicalEngine(p.engine)) {
    throw new Error(`engine "${p.engine}" supports only pitr restore, not "${p.mode}"`);
  }
  const clientImage = p.clientImage ?? DEFAULT_PG_CLIENT_IMAGE;
  const resticImage = p.resticImage ?? DEFAULT_RESTIC_IMAGE;
  const dumpAll = p.engine === 'pg_dumpall';
  if (dumpAll && p.mode === 'single-database') {
    throw new Error('single-database restore needs a pg_dump (per-db) backup, not pg_dumpall');
  }
  assertSnapshotRef(p.snapshotId);
  const scratch = scratchVolumeName(`${p.commandId}-restore`);
  await docker.docker.createVolume({ Name: scratch });
  try {
    // 1) Fetch the dump out of restic onto the scratch volume.
    const fetch = await runSidecar(
      docker,
      {
        image: resticImage,
        args: ['restore', p.snapshotId, '--target', '/', '--json'],
        env: repoEnv(p.repo),
        binds: [`${scratch}:${DUMP_MOUNT}`, ...repoBinds(p.repo)],
        networkMode: p.resticNetwork,
      },
      onLine,
    );
    if (fetch.exitCode !== 0) {
      throw new Error(fetch.stderr.trim() || `restic restore exited ${fetch.exitCode}`);
    }
    const bytesRestored = await restoredBytes(docker, fetch.stdout, {
      image: resticImage,
      repo: p.repo,
      snapshotId: p.snapshotId,
      network: p.resticNetwork,
    });

    // 2) Load it back into the target database.
    const targetDb = assertDbName(p.database ?? p.conn.database);
    const script = logicalRestoreScript(dumpAll);
    const load = await runSidecar(
      docker,
      {
        image: clientImage,
        entrypoint: ['/bin/sh', '-c'],
        args: [script],
        env: pgEnv({ ...p.conn, database: targetDb }),
        binds: [`${scratch}:${DUMP_MOUNT}:ro`],
        networkMode: p.network,
      },
      onLine,
    );
    if (load.exitCode !== 0) {
      throw new Error(load.stderr.trim() || `restore (${p.engine}) exited ${load.exitCode}`);
    }
    return {
      mode: p.mode,
      engine: p.engine,
      database: dumpAll ? undefined : targetDb,
      bytesRestored,
      durationMs: Date.now() - started,
    };
  } finally {
    await docker.docker.getVolume(scratch).remove({ force: true }).catch(() => undefined);
  }
}

async function restoreDbPitr(
  docker: DockerClient,
  p: DbRestorePayload,
  started: number,
  onLine: (line: string) => void,
): Promise<DbRestoreResult> {
  if (!isPhysicalEngine(p.engine)) {
    throw new Error(`pitr restore requires a physical engine (wal-g/pgbackrest), got "${p.engine}"`);
  }
  if (!p.dataVolume) {
    throw new Error('pitr restore requires the target PGDATA volume (dataVolume) to be set');
  }
  const { env, bucket, endpoint, prefix } = physicalEnv(p.repo);
  const target = p.targetTime ?? '';
  const scriptEnv = pitrScriptEnv(p);
  const dataVolume = assertVolumeName(p.dataVolume);
  // Restore into the path the server will read (QA-074), not a sidecar-only one.
  const layout = await resolvePgDataLayout(docker, p.conn.host, dataVolume);
  if (p.engine === 'wal-g') {
    const image = p.engineImage ?? DEFAULT_WALG_IMAGE;
    // Fetch the base backup, then stage a recovery target so PG replays WAL to it.
    const res = await runSidecar(
      docker,
      {
        image,
        entrypoint: ['/bin/sh', '-c'],
        args: [walgRestoreScript(Boolean(target))],
        env: [...env, ...scriptEnv, `PGDATA=${layout.pgdata}`],
        binds: [`${dataVolume}:${layout.mountTarget}`],
        networkMode: p.network,
      },
      onLine,
    );
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `wal-g backup-fetch exited ${res.exitCode}`);
    }
  } else {
    const image = p.engineImage ?? DEFAULT_PGBACKREST_IMAGE;
    const flags = pgBackRestRepoFlags(p.repo, bucket, endpoint, prefix);
    const res = await runSidecar(
      docker,
      {
        image,
        entrypoint: ['/bin/sh', '-c'],
        args: [pgbackrestRestoreScript(flags, Boolean(target))],
        env: [...env, ...scriptEnv, `PGDATA=${layout.pgdata}`],
        binds: [`${dataVolume}:${layout.mountTarget}`],
        networkMode: p.network,
      },
      onLine,
    );
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `pgbackrest restore exited ${res.exitCode}`);
    }
  }
  return {
    mode: p.mode,
    engine: p.engine,
    bytesRestored: 0,
    recoveredTo: target || undefined,
    durationMs: Date.now() - started,
  };
}
