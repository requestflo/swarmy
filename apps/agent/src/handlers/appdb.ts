/**
 * App-DB logical backups (MySQL / MariaDB / MongoDB / Redis / Valkey compose
 * services). The flow and the trust story live in `@swarmy/core/protocol`
 * `appDb.ts`; the shell each sidecar runs is built (and golden-tested) in
 * `appDbScripts.ts`. This handler only wires containers:
 *
 *   probe  = non-interactive exec in the live task → credentials (agent memory)
 *   dump   = one-shot from the task's own image, in the task's netns
 *            (`container:<id>` → 127.0.0.1), writes a scratch volume
 *   store  = restic sidecar (the same repo/tags/retention as every backup)
 *
 * Restore and the drill's verify are the same pieces in reverse. No leg uses
 * stdin (unreliable under Bun), no credential touches node disk (option files
 * live on the sidecar's /dev/shm tmpfs) or the WS (the probe runs here).
 */
import { randomBytes } from 'node:crypto';
import type { DockerClient } from '@swarmy/core/docker';
import {
  APPDB_DUMP_MOUNT,
  DEFAULT_RESTIC_IMAGE,
  KV_PLACE_SCRIPT,
  appDbRetentionTags,
  dumpScript,
  isKvEngine,
  loadScript,
  parseProbeOutput,
  parseScriptOutputs,
  probeScript,
  redisArgHints,
  scratchServerEnv,
  verifyScript,
  type AppDbBackupPayload,
  type AppDbBackupResult,
  type AppDbRestorePayload,
  type AppDbRestoreResult,
  type AppDbVerifyPayload,
  type AppDbVerifyResult,
} from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import {
  applyRetention,
  ensureRepo,
  parseSummary,
  repoBinds,
  repoEnv,
  runSidecar,
  streamer,
} from './backup';

const D = APPDB_DUMP_MOUNT;

// ── docker stream demux (pure) ───────────────────────────────────────────────

/**
 * Split Docker's multiplexed (non-TTY) stream: 8-byte frames `[type,0,0,0,
 * size(u32 BE)]` + payload, type 1 = stdout, 2 = stderr. A buffer that is not
 * framed (a TTY stream) is returned whole as stdout.
 */
export function demuxDockerStream(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i]!;
    if ((type !== 0 && type !== 1 && type !== 2) || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) {
      return { stdout: buf.toString('utf8'), stderr: '' };
    }
    const size = buf.readUInt32BE(i + 4);
    const chunk = buf.subarray(i + 8, i + 8 + size);
    (type === 2 ? err : out).push(chunk);
    i += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

// ── container helpers ────────────────────────────────────────────────────────

interface LocalTask {
  id: string;
  imageId: string;
}

/** This node's running task of a swarm service (`docker ps` is node-local). */
async function localTask(docker: DockerClient, service: string): Promise<LocalTask | null> {
  const list = await docker.docker.listContainers({
    filters: { label: [`com.docker.swarm.service.name=${service}`], status: ['running'] },
  });
  const c = list[0];
  if (!c) return null;
  return { id: c.Id, imageId: c.ImageID };
}

async function requireTask(docker: DockerClient, service: string): Promise<LocalTask> {
  const t = await localTask(docker, service);
  if (!t) throw new Error(`no running task of ${service} on this node`);
  return t;
}

/** Non-interactive exec capturing output (non-hijacked — fine under Bun). */
async function execCapture(
  docker: DockerClient,
  containerId: string,
  script: string,
  env: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const exec = await docker.docker.getContainer(containerId).exec({
    Cmd: ['sh', '-c', script],
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = (await exec.start({})) as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
    stream.on('error', () => resolve());
  });
  const inspect = await exec.inspect();
  return { exitCode: inspect.ExitCode ?? 0, ...demuxDockerStream(Buffer.concat(chunks)) };
}

/** Resolve credentials inside the task. The values never leave this process. */
async function probe(docker: DockerClient, task: LocalTask, p: { creds: AppDbBackupPayload['creds'] }): Promise<string[]> {
  const env: string[] = [];
  if (p.creds.password.some((s) => s.kind === 'redis-cmdline')) {
    // Redis rewrites its process title; the configured argv is in the inspect.
    const info = await docker.docker.getContainer(task.id).inspect();
    const hints = redisArgHints([...(info.Config?.Entrypoint ?? []), ...(info.Config?.Cmd ?? [])]);
    if (hints.password) env.push(`SWARMY_REDIS_ARGPW=${hints.password}`);
    if (hints.conf) env.push(`SWARMY_REDIS_CONF=${hints.conf}`);
  }
  const res = await execCapture(docker, task.id, probeScript(p.creds), env);
  if (res.exitCode !== 0) throw new Error(`credential probe exited ${res.exitCode}: ${res.stderr.trim().slice(-300)}`);
  const vars = parseProbeOutput(res.stdout);
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`);
}

function scratchName(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'job'}`;
}

async function withScratch<T>(docker: DockerClient, name: string, fn: () => Promise<T>): Promise<T> {
  await docker.docker.createVolume({ Name: name, Labels: { 'swarmy.appdb.scratch': 'true' } });
  try {
    return await fn();
  } finally {
    await docker.docker.getVolume(name).remove({ force: true }).catch(() => undefined);
  }
}

function tail(s: string, n = 400): string {
  return s.trim().slice(-n);
}

/** Fetch a snapshot's dump files onto the scratch volume. */
async function fetchDump(
  docker: DockerClient,
  p: { repo: AppDbRestorePayload['repo']; snapshotId: string; network?: string; resticImage?: string },
  scratch: string,
  onLine: (l: string) => void,
): Promise<void> {
  const res = await runSidecar(
    docker,
    {
      image: p.resticImage ?? DEFAULT_RESTIC_IMAGE,
      args: ['restore', p.snapshotId, '--target', '/', '--json'],
      env: repoEnv(p.repo),
      binds: [`${scratch}:${D}`, ...repoBinds(p.repo)],
      networkMode: p.network,
    },
    onLine,
  );
  if (res.exitCode !== 0) throw new Error(tail(res.stderr) || `restic restore exited ${res.exitCode}`);
}

// ── backup ───────────────────────────────────────────────────────────────────

export async function appDbBackup(
  docker: DockerClient,
  conn: AgentConnection,
  p: AppDbBackupPayload,
): Promise<AppDbBackupResult> {
  const started = Date.now();
  const onLine = streamer(conn, p.commandId);
  const task = await requireTask(docker, p.service);
  const kv = isKvEngine(p.engine);
  if (kv && (!p.dataVolume || !p.dataMount)) {
    throw new Error(`${p.engine} backups need the data volume and its mount path`);
  }
  const credEnv = await probe(docker, task, p);
  const resticImage = p.resticImage ?? DEFAULT_RESTIC_IMAGE;

  return withScratch(docker, scratchName('swarmy-appdb', p.jobId), async () => {
    const scratch = scratchName('swarmy-appdb', p.jobId);
    const dump = await runSidecar(
      docker,
      {
        image: task.imageId,
        pull: false,
        entrypoint: ['/bin/sh', '-c'],
        args: [dumpScript(p.engine, p.creds.scope)],
        env: [...credEnv, ...(kv ? [`SWARMY_DATA_MOUNT=${p.dataMount}`] : [])],
        binds: [`${scratch}:${D}`, ...(kv ? [`${p.dataVolume}:${p.dataMount}:ro`] : [])],
        networkMode: `container:${task.id}`,
        user: '0:0',
      },
      onLine,
    );
    if (dump.exitCode !== 0) {
      throw new Error(`${p.engine} dump failed (exit ${dump.exitCode}): ${tail(dump.stderr) || tail(dump.stdout)}`);
    }
    const outs = parseScriptOutputs(dump.stdout);

    await ensureRepo(docker, resticImage, p.repo, p.network);
    const store = await runSidecar(
      docker,
      {
        image: resticImage,
        args: ['backup', D, '--json', '--host', p.host, ...p.tags.flatMap((t) => ['--tag', t])],
        env: repoEnv(p.repo),
        binds: [`${scratch}:${D}:ro`, ...repoBinds(p.repo)],
        networkMode: p.network,
      },
      onLine,
    );
    if (store.exitCode !== 0) throw new Error(tail(store.stderr) || `restic backup exited ${store.exitCode}`);
    const summary = parseSummary(store.stdout);

    const retention =
      p.retentionDays != null
        ? await applyRetention(
            docker,
            {
              image: resticImage,
              repo: p.repo,
              retentionDays: p.retentionDays,
              tags: appDbRetentionTags(p.tags),
              host: p.host,
              network: p.network,
            },
            onLine,
          )
        : undefined;

    const aof = outs.appendonly?.[0];
    return {
      snapshotId: summary.snapshot_id ?? 'unknown',
      engine: p.engine,
      sizeBytes: summary.total_bytes_processed ?? 0,
      databases: outs.db ?? [],
      ...(outs.tool?.[0] ? { tool: outs.tool[0] } : {}),
      ...(outs.rdbpath?.[0] ? { rdbPath: outs.rdbpath[0] } : {}),
      ...(aof ? { appendonly: aof === 'yes' } : {}),
      durationMs: Date.now() - started,
      ...(retention ? { retention } : {}),
    };
  });
}

// ── restore ──────────────────────────────────────────────────────────────────

export async function appDbRestore(
  docker: DockerClient,
  conn: AgentConnection,
  p: AppDbRestorePayload,
): Promise<AppDbRestoreResult> {
  const started = Date.now();
  const onLine = streamer(conn, p.commandId);
  const kv = isKvEngine(p.engine);
  const scratch = scratchName('swarmy-appdbr', p.commandId);

  if (kv) {
    const targetVolume = p.mode === 'copy' ? p.copyVolume : p.dataVolume;
    if (!targetVolume) throw new Error(`${p.engine} ${p.mode} restore needs a target volume`);
    if (p.mode === 'in-place' && (await localTask(docker, p.service))) {
      // The controller scales the service to 0 first; never swap an RDB under a live server.
      throw new Error(`${p.service} is still running on this node — refusing to replace its RDB`);
    }
    return withScratch(docker, scratch, async () => {
      await fetchDump(docker, p, scratch, onLine);
      if (p.mode === 'copy') {
        await docker.docker.createVolume({ Name: targetVolume, Labels: { 'swarmy.appdb.restoreOf': p.service } });
      }
      const place = await runSidecar(
        docker,
        {
          image: p.resticImage ?? DEFAULT_RESTIC_IMAGE,
          entrypoint: ['/bin/sh', '-c'],
          args: [KV_PLACE_SCRIPT],
          env: [`SWARMY_SUFFIX=${p.suffix}`],
          binds: [`${scratch}:${D}:ro`, `${targetVolume}:/target`],
          user: '0:0',
        },
        onLine,
      );
      if (place.exitCode !== 0) throw new Error(`placing the RDB failed: ${tail(place.stderr)}`);
      return {
        mode: p.mode,
        engine: p.engine,
        databases: [],
        volume: targetVolume,
        durationMs: Date.now() - started,
      };
    });
  }

  const task = await requireTask(docker, p.service);
  const credEnv = await probe(docker, task, p);
  return withScratch(docker, scratch, async () => {
    await fetchDump(docker, p, scratch, onLine);
    const load = await runSidecar(
      docker,
      {
        image: task.imageId,
        pull: false,
        entrypoint: ['/bin/sh', '-c'],
        args: [loadScript(p.engine as 'mysql' | 'mariadb' | 'mongo')],
        env: [...credEnv, `SWARMY_MODE=${p.mode}`, `SWARMY_SUFFIX=${p.suffix}`],
        binds: [`${scratch}:${D}:ro`],
        networkMode: `container:${task.id}`,
        user: '0:0',
      },
      onLine,
    );
    if (load.exitCode !== 0) {
      throw new Error(`${p.engine} load failed (exit ${load.exitCode}): ${tail(load.stderr) || tail(load.stdout)}`);
    }
    return {
      mode: p.mode,
      engine: p.engine,
      databases: parseScriptOutputs(load.stdout).db ?? [],
      durationMs: Date.now() - started,
    };
  });
}

// ── verify (drill) ───────────────────────────────────────────────────────────

export async function appDbVerify(
  docker: DockerClient,
  conn: AgentConnection,
  p: AppDbVerifyPayload,
): Promise<AppDbVerifyResult> {
  const started = Date.now();
  const onLine = streamer(conn, p.commandId);
  const kv = isKvEngine(p.engine);
  const dataMount = p.dataMount || '/data';
  const scratch = scratchName('swarmy-appdbv', p.commandId);
  const seedVolume = scratchName('swarmy-appdbv-data', p.commandId);
  const password = randomBytes(18).toString('hex');
  const env = scratchServerEnv(p.engine, password);
  let serverId: string | null = null;

  try {
    return await withScratch(docker, scratch, async () => {
      await fetchDump(docker, p, scratch, onLine);
      await docker.pullImage(p.image).catch(() => undefined);

      if (kv) {
        await docker.docker.createVolume({ Name: seedVolume, Labels: { 'swarmy.appdb.scratch': 'true' } });
        const seed = await runSidecar(docker, {
          image: p.resticImage ?? DEFAULT_RESTIC_IMAGE,
          entrypoint: ['/bin/sh', '-c'],
          args: [KV_PLACE_SCRIPT],
          env: ['SWARMY_SUFFIX=verify'],
          binds: [`${scratch}:${D}:ro`, `${seedVolume}:/target`],
          user: '0:0',
        });
        if (seed.exitCode !== 0) throw new Error(`seeding the scratch RDB failed: ${tail(seed.stderr)}`);
      }

      const server = await docker.docker.createContainer({
        Image: p.image,
        Env: env.server,
        Labels: { 'swarmy.appdb.verify': 'true' },
        HostConfig: {
          NetworkMode: 'none',
          AutoRemove: false,
          Binds: kv ? [`${seedVolume}:${dataMount}`] : [],
        },
      });
      serverId = server.id;
      await server.start();

      const check = await runSidecar(
        docker,
        {
          image: p.image,
          pull: false,
          entrypoint: ['/bin/sh', '-c'],
          args: [verifyScript(p.engine)],
          env: [...env.client, 'SWARMY_SUFFIX=verify'],
          binds: [`${scratch}:${D}:ro`],
          networkMode: `container:${server.id}`,
          user: '0:0',
        },
        onLine,
      );
      if (check.exitCode !== 0) {
        let logs = '';
        try {
          const raw = (await server.logs({ stdout: true, stderr: true, tail: 15 })) as unknown as Buffer;
          const d = demuxDockerStream(Buffer.from(raw));
          logs = tail(`${d.stdout}\n${d.stderr}`, 300);
        } catch {
          logs = '';
        }
        throw new Error(
          `scratch restore failed (exit ${check.exitCode}): ${tail(check.stderr) || tail(check.stdout)}${logs ? ` · server: ${logs}` : ''}`,
        );
      }
      const outs = parseScriptOutputs(check.stdout);
      const objects = Number(outs.objects?.[0] ?? 0);
      return {
        engine: p.engine,
        databases: outs.db ?? [],
        objects: Number.isFinite(objects) && objects >= 0 ? Math.floor(objects) : 0,
        durationMs: Date.now() - started,
      };
    });
  } finally {
    if (serverId) await docker.docker.getContainer(serverId).remove({ force: true, v: true }).catch(() => undefined);
    if (kv) await docker.docker.getVolume(seedVolume).remove({ force: true }).catch(() => undefined);
  }
}
