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
} from '@swarmy/core/protocol';
import {
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
/** Where the primary's PGDATA is mounted for physical engines. */
const PGDATA_MOUNT = '/pgdata';

interface RunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Build the env array (`KEY=VALUE`) restic needs for the repo. */
function repoEnv(repo: ResticRepo): string[] {
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
async function runSidecar(
  docker: DockerClient,
  opts: {
    image: string;
    args: string[];
    env: string[];
    binds: string[];
    networkMode?: string;
    /** Override the image ENTRYPOINT (e.g. ['/bin/sh','-c']) to run a tool directly. */
    entrypoint?: string[];
  },
  onLine?: (line: string) => void,
): Promise<RunOutput> {
  const d = docker.docker;
  await docker.pullImage(opts.image).catch(() => undefined);

  let stdout = '';
  let stderr = '';
  const chunks = { write: (s: string, isErr: boolean) => (isErr ? (stderr += s) : (stdout += s)) };

  const container = await d.createContainer({
    Image: opts.image,
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
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/** Ensure the restic repo exists (idempotent — `init` no-ops on an existing repo). */
async function ensureRepo(
  docker: DockerClient,
  image: string,
  repo: ResticRepo,
  networkMode?: string,
): Promise<void> {
  await runSidecar(docker, {
    image,
    args: ['init'],
    env: repoEnv(repo),
    binds: [],
    networkMode,
  }).catch(() => undefined);
}

function streamer(conn: AgentConnection, commandId: string): (line: string) => void {
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
  await ensureRepo(docker, image, p.repo, p.network);

  const tagArgs = p.tags.flatMap((t) => ['--tag', t]);
  const res = await runSidecar(
    docker,
    {
      image,
      args: ['backup', MOUNT, '--json', '--host', p.volume, ...tagArgs],
      env: repoEnv(p.repo),
      binds: [`${p.volume}:${MOUNT}:ro`],
      networkMode: p.network,
    },
    streamer(conn, p.commandId),
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `restic backup exited ${res.exitCode}`);
  }

  // restic --json emits one summary object on the final line.
  const summary = parseSummary(res.stdout);
  return {
    snapshotId: summary.snapshot_id ?? 'unknown',
    sizeBytes: summary.total_bytes_processed ?? 0,
    filesNew: summary.files_new,
    durationMs: Date.now() - started,
  };
}

export async function restoreVolume(
  docker: DockerClient,
  conn: AgentConnection,
  p: RestoreVolumePayload,
): Promise<import('@swarmy/core/protocol').RestoreVolumeResult> {
  const image = p.image ?? DEFAULT_RESTIC_IMAGE;
  const started = Date.now();

  // Ensure the destination volume exists (idempotent create).
  await docker.docker.createVolume({ Name: p.targetVolume }).catch(() => undefined);

  const res = await runSidecar(
    docker,
    {
      image,
      // `--target /` because the snapshot stored the absolute mount path (/data).
      args: ['restore', p.snapshotId, '--target', '/', '--json'],
      env: repoEnv(p.repo),
      binds: [`${p.targetVolume}:${MOUNT}`],
      networkMode: p.network,
    },
    streamer(conn, p.commandId),
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `restic restore exited ${res.exitCode}`);
  }
  const summary = parseSummary(res.stdout);
  return {
    targetVolume: p.targetVolume,
    bytesRestored: summary.total_bytes ?? summary.total_bytes_processed ?? 0,
    durationMs: Date.now() - started,
  };
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
    binds: [],
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
function parseSummary(stdout: string): ResticSummary {
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
function pgEnv(conn: DbConnection): string[] {
  return [
    `PGPASSWORD=${conn.password}`,
    `DBHOST=${conn.host}`,
    `DBPORT=${conn.port}`,
    `DBUSER=${conn.user}`,
    `DBNAME=${conn.database}`,
  ];
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
      },
      onLine,
    );
    if (dump.exitCode !== 0) {
      throw new Error(dump.stderr.trim() || `${p.engine} exited ${dump.exitCode}`);
    }

    // 2) Store the staged dump with restic into the same target catalog.
    await ensureRepo(docker, resticImage, p.repo);
    const tagArgs = p.tags.flatMap((t) => ['--tag', t]);
    const store = await runSidecar(
      docker,
      {
        image: resticImage,
        args: ['backup', DUMP_MOUNT, '--json', '--host', p.conn.database, ...tagArgs],
        env: repoEnv(p.repo),
        binds: [`${scratch}:${DUMP_MOUNT}:ro`],
      },
      onLine,
    );
    if (store.exitCode !== 0) {
      throw new Error(store.stderr.trim() || `restic backup exited ${store.exitCode}`);
    }
    const summary = parseSummary(store.stdout);
    return {
      snapshotId: summary.snapshot_id ?? 'unknown',
      engine: p.engine,
      sizeBytes: summary.total_bytes_processed ?? 0,
      databases: dumpAll ? ['*'] : [p.conn.database],
      durationMs: Date.now() - started,
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
  if (p.engine === 'wal-g') {
    const image = p.engineImage ?? DEFAULT_WALG_IMAGE;
    const res = await runSidecar(
      docker,
      {
        image,
        entrypoint: ['/bin/sh', '-c'],
        args: ['set -e; export PGDATA=' + PGDATA_MOUNT + '; wal-g backup-push "$PGDATA"'],
        env: [...env, `PGDATA=${PGDATA_MOUNT}`],
        binds: [`${p.dataVolume}:${PGDATA_MOUNT}:ro`],
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
      args: [
        `set -e; pgbackrest --stanza=swarmy --pg1-path=${PGDATA_MOUNT} ${flags} stanza-create || true; ` +
          `pgbackrest --stanza=swarmy --pg1-path=${PGDATA_MOUNT} ${flags} --type=full backup`,
      ],
      env,
      binds: [`${p.dataVolume}:${PGDATA_MOUNT}`],
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

function pgBackRestRepoFlags(repo: ResticRepo, bucket: string, endpoint: string, prefix: string): string {
  const host = endpoint.replace(/^https?:\/\//, '');
  return [
    '--repo1-type=s3',
    `--repo1-s3-bucket=${bucket}`,
    `--repo1-s3-endpoint=${host}`,
    `--repo1-s3-region=${repo.region ?? 'us-east-1'}`,
    `--repo1-path=/${prefix || 'pgbackrest'}`,
    '--repo1-s3-uri-style=path',
  ].join(' ');
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
        binds: [`${scratch}:${DUMP_MOUNT}`],
      },
      onLine,
    );
    if (fetch.exitCode !== 0) {
      throw new Error(fetch.stderr.trim() || `restic restore exited ${fetch.exitCode}`);
    }

    // 2) Load it back into the target database.
    const targetDb = p.database ?? p.conn.database;
    const script = dumpAll
      ? `set -e; psql -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" --no-password -d postgres -f ${DUMP_MOUNT}/dump.sql`
      : `set -e; pg_restore -h "$DBHOST" -p "$DBPORT" -U "$DBUSER" --no-password -d "${targetDb}" ` +
        `--clean --if-exists --no-owner ${DUMP_MOUNT}/dump.pgc`;
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
      bytesRestored: 0,
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
  if (p.engine === 'wal-g') {
    const image = p.engineImage ?? DEFAULT_WALG_IMAGE;
    // Fetch the base backup, then stage a recovery target so PG replays WAL to it.
    const recoveryConf = target
      ? `printf "recovery_target_time = '%s'\\nrecovery_target_action = 'promote'\\n" "${target}" ` +
        `>> ${PGDATA_MOUNT}/postgresql.auto.conf; touch ${PGDATA_MOUNT}/recovery.signal;`
      : '';
    const res = await runSidecar(
      docker,
      {
        image,
        entrypoint: ['/bin/sh', '-c'],
        args: [
          `set -e; export PGDATA=${PGDATA_MOUNT}; wal-g backup-fetch "$PGDATA" ${p.snapshotId || 'LATEST'}; ${recoveryConf}`,
        ],
        env: [...env, `PGDATA=${PGDATA_MOUNT}`],
        binds: [`${p.dataVolume}:${PGDATA_MOUNT}`],
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
    const typeFlag = target ? `--type=time --target="${target}"` : '--type=default';
    const res = await runSidecar(
      docker,
      {
        image,
        entrypoint: ['/bin/sh', '-c'],
        args: [
          `set -e; pgbackrest --stanza=swarmy --pg1-path=${PGDATA_MOUNT} ${flags} ${typeFlag} --delta restore`,
        ],
        env,
        binds: [`${p.dataVolume}:${PGDATA_MOUNT}`],
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
