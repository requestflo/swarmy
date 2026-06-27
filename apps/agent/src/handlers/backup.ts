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
  ListSnapshotsPayload,
  ResticRepo,
  ResticSnapshotInfo,
  RestoreVolumePayload,
} from '@swarmy/core/protocol';
import { DEFAULT_RESTIC_IMAGE } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';

/** Where the volume is mounted inside the restic container. */
const MOUNT = '/data';

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
 * Run a one-shot restic container and collect its output. `binds` are docker
 * `Binds` entries (e.g. `volname:/data:ro`). The container is auto-removed.
 */
async function runRestic(
  docker: DockerClient,
  opts: { image: string; args: string[]; env: string[]; binds: string[] },
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
    HostConfig: { Binds: opts.binds, AutoRemove: false },
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
async function ensureRepo(docker: DockerClient, image: string, repo: ResticRepo): Promise<void> {
  await runRestic(docker, { image, args: ['init'], env: repoEnv(repo), binds: [] }).catch(
    () => undefined,
  );
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
  await ensureRepo(docker, image, p.repo);

  const tagArgs = p.tags.flatMap((t) => ['--tag', t]);
  const res = await runRestic(
    docker,
    {
      image,
      args: ['backup', MOUNT, '--json', '--host', p.volume, ...tagArgs],
      env: repoEnv(p.repo),
      binds: [`${p.volume}:${MOUNT}:ro`],
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

  const res = await runRestic(
    docker,
    {
      image,
      // `--target /` because the snapshot stored the absolute mount path (/data).
      args: ['restore', p.snapshotId, '--target', '/', '--json'],
      env: repoEnv(p.repo),
      binds: [`${p.targetVolume}:${MOUNT}`],
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
  await ensureRepo(docker, image, p.repo);
  const tagArgs = p.tags.flatMap((t) => ['--tag', t]);
  const res = await runRestic(docker, {
    image,
    args: ['snapshots', '--json', ...tagArgs],
    env: repoEnv(p.repo),
    binds: [],
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
