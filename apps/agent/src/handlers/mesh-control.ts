/**
 * The self-hosted mesh control plane on this node (plans/
 * epic-self-hosted-mesh-and-fleets.md M1): supervise `swarmy-mesh-control`
 * (the combined NetBird server, host network, NOT a swarm service) and its
 * Litestream sidecar `swarmy-mesh-litestream`.
 *
 * Why the agent and not swarm: the swarm is born on the mesh, so if the mesh
 * breaks and raft loses quorum swarm could not reschedule anything. The thing
 * the swarm depends on must not depend on the swarm.
 *
 * Secrets: the rendered config (authSecret, encryptionKey) is served from
 * the container's tmpfs — never the image, the container spec or `docker
 * inspect` — written through `docker exec` (spike §11.1: `docker cp` can't
 * reach a tmpfs). {@link superviseMeshControl} (every 10 s, independent of the
 * controller connection) keeps it there from the agent's own 0600 copy in its
 * state dir.
 *
 * Cold boot (QA-066 d): the tmpfs is empty after a reboot, and the agent may
 * not be running yet — on a multi-manager swarm nothing on this node may wait
 * for the agent, the overlay or the swarm, because they all wait for the mesh
 * this container serves. So the config also persists in its own root-only
 * volume (`swarmy-mesh-control-conf`: a 0700 dir, 0600 files — the same
 * protection as the agent's copy on the same disk), and the entrypoint seeds
 * the empty tmpfs from it before waiting. dockerd alone brings :8081 back. The
 * copy is never in the NetBird volume, so store.db and its encryptionKey
 * still don't sit together, and it is written before any restart, so a restart
 * never seeds a stale config.
 *
 * Gated by SWARMY_ALLOW_MESH (executor), like the node sidecar.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DockerClient, defaultContainerLogConfig } from '@swarmy/core/docker';
import type { ApplyMeshControlPayload, MeshControlSpec, MeshControlStatus } from '@swarmy/core/protocol';
import { env } from '../env';
import { enforceMeshFirewall } from './mesh-firewall';
import { MESH_FRONT_CONTAINER, ensureMeshFront } from './mesh-front';
import { agentPackaging } from './update';

/** Stable names: re-applies reconcile one container, the installer uses the same. */
export const MESH_CONTROL_CONTAINER = 'swarmy-mesh-control';
export const MESH_CONTROL_VOLUME = 'swarmy-mesh-control';
export const MESH_LITESTREAM_CONTAINER = 'swarmy-mesh-litestream';
/** Root-only volume holding the persisted config the entrypoint seeds the tmpfs from (QA-066 d). */
export const MESH_CONTROL_CONF_VOLUME = 'swarmy-mesh-control-conf';
const CONF_DIR = '/var/lib/swarmy-mesh-conf';
const CONFIG_DIR = '/run/swarmy-mesh';
const CONFIG_FILE = `${CONFIG_DIR}/config.yaml`;
const DATA_DIR = '/var/lib/netbird';
const LS_CONFIG_FILE = '/run/swarmy-litestream/litestream.yml';
const IMAGE_LABEL = 'swarmy.mesh.control.image';

/**
 * Seed the tmpfs from the persisted copy when it is empty (a reboot), wait for
 * the config, then exec the server (PID 1 becomes netbird-server).
 * Keep in sync with scripts/install-swarmy.sh (mesh-control.test.ts checks).
 */
export const MESH_CONTROL_ENTRYPOINT = [
  'sh',
  '-c',
  `umask 077; chmod 0700 ${CONF_DIR} 2>/dev/null; ` +
    `if [ ! -s ${CONFIG_FILE} ] && [ -s ${CONF_DIR}/config.yaml ]; then ` +
    `if [ -s ${CONF_DIR}/extra-ca.pem ]; then cp ${CONF_DIR}/extra-ca.pem ${CONFIG_DIR}/extra-ca.pem; fi; ` +
    `cp ${CONF_DIR}/config.yaml ${CONFIG_FILE}.tmp && mv ${CONFIG_FILE}.tmp ${CONFIG_FILE}; fi; ` +
    // An extra CA (written before the config) joins the system roots for this process only.
    `while [ ! -s ${CONFIG_FILE} ]; do sleep 0.2; done; ` +
    `if [ -s ${CONFIG_DIR}/extra-ca.pem ]; then cat /etc/ssl/certs/ca-certificates.crt ${CONFIG_DIR}/extra-ca.pem > ${CONFIG_DIR}/ca.pem; export SSL_CERT_FILE=${CONFIG_DIR}/ca.pem; fi; ` +
    `exec /go/bin/netbird-server --config ${CONFIG_FILE}`,
];
const LITESTREAM_ENTRYPOINT = [
  'sh',
  '-c',
  `while [ ! -s ${LS_CONFIG_FILE} ]; do sleep 0.2; done; exec litestream replicate -config ${LS_CONFIG_FILE}`,
];

/** Where the agent keeps its copy (next to agent.json; the installer writes the same files). */
export function meshControlStateDir(): string {
  return path.join(path.dirname(env.STATE_PATH), 'mesh-control');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface ExecOut {
  code: number;
  stdout: string;
  stderr: string;
}

async function execIn(docker: DockerClient, name: string, cmd: string[]): Promise<ExecOut> {
  const exec = await docker.docker.getContainer(name).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  let stdout = '';
  let stderr = '';
  await new Promise<void>((resolve) => {
    const out = { write: (b: Buffer) => ((stdout += b.toString('utf8')), true) } as unknown as NodeJS.WritableStream;
    const err = { write: (b: Buffer) => ((stderr += b.toString('utf8')), true) } as unknown as NodeJS.WritableStream;
    (docker.docker.modem as unknown as {
      demuxStream(s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream): void;
    }).demuxStream(stream, out, err);
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
  const inspect = await exec.inspect();
  return { code: inspect.ExitCode ?? 1, stdout, stderr };
}

/**
 * Write a file into a (tmpfs) path inside a running container. The content
 * rides the exec's argv as base64: exec configs live only in dockerd's memory,
 * never on disk.
 */
async function writeInto(docker: DockerClient, name: string, file: string, contents: string): Promise<void> {
  const b64 = Buffer.from(contents, 'utf8').toString('base64');
  const r = await execIn(docker, name, [
    'sh',
    '-c',
    `umask 077; printf '%s' "$1" | base64 -d > "$2.tmp" && mv "$2.tmp" "$2"`,
    'sh',
    b64,
    file,
  ]);
  if (r.code !== 0) throw new Error(`writing ${file} in ${name} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

async function inspectOrNull(docker: DockerClient, name: string) {
  return docker.docker
    .getContainer(name)
    .inspect()
    .catch(() => null);
}

// ── local copy ───────────────────────────────────────────────────────────────

async function saveLocal(spec: MeshControlSpec): Promise<void> {
  const dir = meshControlStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, 'config.yaml'), spec.configYaml, { mode: 0o600 });
  await writeFile(path.join(dir, 'image'), spec.image + '\n', { mode: 0o600 });
  await writeFile(path.join(dir, 'env.json'), JSON.stringify(spec.env ?? {}), { mode: 0o600 });
  if (spec.caPem) await writeFile(path.join(dir, 'extra-ca.pem'), spec.caPem, { mode: 0o600 });
  else await rm(path.join(dir, 'extra-ca.pem'), { force: true });
  if (spec.litestream) {
    await writeFile(path.join(dir, 'litestream.json'), JSON.stringify(spec.litestream), { mode: 0o600 });
  } else {
    await rm(path.join(dir, 'litestream.json'), { force: true });
  }
}

/** The spec the agent holds (written by the controller's apply or by the installer). */
export async function loadLocalSpec(): Promise<MeshControlSpec | null> {
  const dir = meshControlStateDir();
  try {
    const configYaml = await readFile(path.join(dir, 'config.yaml'), 'utf8');
    const image = (await readFile(path.join(dir, 'image'), 'utf8')).trim();
    const envJson = await readFile(path.join(dir, 'env.json'), 'utf8').catch(() => '{}');
    const lsJson = await readFile(path.join(dir, 'litestream.json'), 'utf8').catch(() => '');
    const caPem = await readFile(path.join(dir, 'extra-ca.pem'), 'utf8').catch(() => '');
    if (!configYaml || !image) return null;
    return {
      image,
      configYaml,
      env: JSON.parse(envJson) as Record<string, string>,
      ...(caPem ? { caPem } : {}),
      litestream: lsJson ? (JSON.parse(lsJson) as MeshControlSpec['litestream']) : null,
    };
  } catch {
    return null;
  }
}

async function forgetLocal(): Promise<void> {
  await rm(meshControlStateDir(), { recursive: true, force: true });
}

// ── containers ───────────────────────────────────────────────────────────────

async function createControl(docker: DockerClient, spec: MeshControlSpec): Promise<void> {
  const d = docker.docker;
  await d.getContainer(MESH_CONTROL_CONTAINER).remove({ force: true }).catch(() => undefined);
  const container = await d.createContainer({
    name: MESH_CONTROL_CONTAINER,
    Image: spec.image,
    Entrypoint: MESH_CONTROL_ENTRYPOINT,
    Cmd: [],
    Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
    Labels: { 'swarmy.managed': 'true', 'swarmy.role': 'mesh-control', [IMAGE_LABEL]: spec.image },
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: defaultContainerLogConfig(),
      Binds: [`${MESH_CONTROL_VOLUME}:${DATA_DIR}`, `${MESH_CONTROL_CONF_VOLUME}:${CONF_DIR}`],
      Tmpfs: { [CONFIG_DIR]: 'rw,noexec,nosuid,size=1m,mode=0700' },
    },
  });
  await container.start();
}

/** Pure: a live container that predates the persisted config (QA-066 d) must be re-created once. */
export function controlNeedsRecreate(cur: {
  Config?: { Entrypoint?: string[] | string | null; Cmd?: string[] | string | null; Labels?: Record<string, string> | null };
  HostConfig?: { Binds?: string[] | null };
} | null, image: string): boolean {
  if (!cur) return true;
  if (cur.Config?.Labels?.[IMAGE_LABEL] !== image) return true;
  // Entrypoint + Cmd: the installer's `--entrypoint sh IMAGE -c '…'` splits the same argv.
  const arr = (v: string[] | string | null | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  const argv = [...arr(cur.Config?.Entrypoint), ...arr(cur.Config?.Cmd)];
  if (argv.join('\u0000') !== MESH_CONTROL_ENTRYPOINT.join('\u0000')) return true;
  return !(cur.HostConfig?.Binds ?? []).includes(`${MESH_CONTROL_CONF_VOLUME}:${CONF_DIR}`);
}

async function fileHashIn(docker: DockerClient, file: string): Promise<string | null> {
  const r = await execIn(docker, MESH_CONTROL_CONTAINER, ['sh', '-c', `[ -s ${file} ] && sha256sum ${file} | cut -d' ' -f1`]).catch(
    () => null,
  );
  if (!r || r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/** Keep the persisted copy (what a reboot seeds from) equal to `spec`. */
async function persistConfig(docker: DockerClient, spec: MeshControlSpec): Promise<void> {
  if (spec.caPem) {
    if ((await fileHashIn(docker, `${CONF_DIR}/extra-ca.pem`)) !== sha256(spec.caPem)) {
      await writeInto(docker, MESH_CONTROL_CONTAINER, `${CONF_DIR}/extra-ca.pem`, spec.caPem);
    }
  } else {
    await execIn(docker, MESH_CONTROL_CONTAINER, ['rm', '-f', `${CONF_DIR}/extra-ca.pem`]).catch(() => undefined);
  }
  if ((await fileHashIn(docker, `${CONF_DIR}/config.yaml`)) !== sha256(spec.configYaml)) {
    await writeInto(docker, MESH_CONTROL_CONTAINER, `${CONF_DIR}/config.yaml`, spec.configYaml);
  }
}

async function configHashInside(docker: DockerClient): Promise<string | null> {
  return fileHashIn(docker, CONFIG_FILE);
}

async function healthy(docker: DockerClient): Promise<boolean> {
  // Up = the management gRPC server accepts connections on its always-plain
  // legacy port. The :9000 /health endpoint is the RELAY's TLS check and
  // answers 503 on a plain-HTTP listener (seen live), so it can't be the signal.
  const r = await execIn(docker, MESH_CONTROL_CONTAINER, ['bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/33073']).catch(() => null);
  return !!r && r.code === 0;
}

/**
 * Pure (QA-077): what the Litestream sidecar must match to be kept. The
 * entrypoint is part of it: the label once covered only image/env/network,
 * so an agent upgrade that changed the script would never have reached a
 * running sidecar (the trap that left QA-072's old front script running).
 */
export function litestreamSpecLabel(ls: { image: string; env: Record<string, string>; network: string }): string {
  return sha256(JSON.stringify({ image: ls.image, env: ls.env, network: ls.network, entrypoint: LITESTREAM_ENTRYPOINT }));
}

async function ensureLitestream(docker: DockerClient, spec: MeshControlSpec): Promise<MeshControlStatus['litestream']> {
  const d = docker.docker;
  const ls = spec.litestream;
  if (!ls) {
    await d.getContainer(MESH_LITESTREAM_CONTAINER).remove({ force: true }).catch(() => undefined);
    return undefined;
  }
  const want = litestreamSpecLabel(ls);
  const cur = await inspectOrNull(docker, MESH_LITESTREAM_CONTAINER);
  if (!cur || cur.Config?.Labels?.['swarmy.mesh.litestream.spec'] !== want) {
    await docker.pullImage(ls.image).catch(() => undefined);
    await d.getContainer(MESH_LITESTREAM_CONTAINER).remove({ force: true }).catch(() => undefined);
    const c = await d.createContainer({
      name: MESH_LITESTREAM_CONTAINER,
      Image: ls.image,
      Entrypoint: LITESTREAM_ENTRYPOINT,
      Cmd: [],
      Env: Object.entries(ls.env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'swarmy.managed': 'true', 'swarmy.role': 'mesh-litestream', 'swarmy.mesh.litestream.spec': want },
      HostConfig: {
        NetworkMode: ls.network,
        RestartPolicy: { Name: 'unless-stopped' },
        LogConfig: defaultContainerLogConfig(),
        Binds: [`${MESH_CONTROL_VOLUME}:${DATA_DIR}`],
        Tmpfs: { [path.dirname(LS_CONFIG_FILE)]: 'rw,noexec,nosuid,size=1m,mode=0700' },
      },
    });
    await c.start();
  } else if (!cur.State?.Running) {
    await d.getContainer(MESH_LITESTREAM_CONTAINER).start().catch(() => undefined);
  }
  const r = await execIn(docker, MESH_LITESTREAM_CONTAINER, ['sh', '-c', `[ -s ${LS_CONFIG_FILE} ] && sha256sum ${LS_CONFIG_FILE} | cut -d' ' -f1`]).catch(
    () => null,
  );
  if (r?.stdout.trim() !== sha256(ls.configYaml)) {
    const had = !!r?.stdout.trim();
    await writeInto(docker, MESH_LITESTREAM_CONTAINER, LS_CONFIG_FILE, ls.configYaml);
    // A running replicate doesn't re-read its config.
    if (had) await d.getContainer(MESH_LITESTREAM_CONTAINER).restart({ t: 25 }).catch(() => undefined);
    if (had) await writeInto(docker, MESH_LITESTREAM_CONTAINER, LS_CONFIG_FILE, ls.configYaml).catch(() => undefined);
  }
  const after = await inspectOrNull(docker, MESH_LITESTREAM_CONTAINER);
  return { running: !!after?.State?.Running };
}

/**
 * Restore the replica into the control-plane volume. Only into an EMPTY
 * volume (no store.db): restoring over live data is never what a move wants.
 */
async function restoreInto(docker: DockerClient, spec: MeshControlSpec): Promise<boolean> {
  const ls = spec.litestream;
  if (!ls) throw new Error('restore needs a litestream replica');
  const d = docker.docker;
  await docker.pullImage(ls.image).catch(() => undefined);
  const name = `${MESH_LITESTREAM_CONTAINER}-restore`;
  await d.getContainer(name).remove({ force: true }).catch(() => undefined);
  // Each DB restores to a temp file, then swaps in (and drops stale -wal/-shm).
  const script = [
    'set -e',
    `[ -s ${DATA_DIR}/store.db ] && { echo "volume not empty"; exit 3; }`,
    `mkdir -p ${path.dirname(LS_CONFIG_FILE)}`,
    `printf '%s' "$SWARMY_LS_CONFIG" | base64 -d > ${LS_CONFIG_FILE}`,
    'unset SWARMY_LS_CONFIG',
    `for db in store idp events; do`,
    `  f=${DATA_DIR}/$db.db`,
    `  litestream restore -config ${LS_CONFIG_FILE} -if-replica-exists -o "$f.restoring" "$f"`,
    `  if [ -s "$f.restoring" ]; then rm -f "$f" "$f-wal" "$f-shm" "${DATA_DIR}/.$db.db-litestream"; mv "$f.restoring" "$f"; fi`,
    'done',
  ].join('\n');
  const c = await d.createContainer({
    name,
    Image: ls.image,
    Entrypoint: ['sh', '-c', script],
    Cmd: [],
    Env: [...Object.entries(ls.env).map(([k, v]) => `${k}=${v}`), `SWARMY_LS_CONFIG=${Buffer.from(ls.configYaml).toString('base64')}`],
    HostConfig: {
      NetworkMode: ls.network,
      Binds: [`${MESH_CONTROL_VOLUME}:${DATA_DIR}`],
      Tmpfs: { [path.dirname(LS_CONFIG_FILE)]: 'rw,size=1m,mode=0700' },
      AutoRemove: false,
    },
  });
  await c.start();
  const res = (await c.wait()) as { StatusCode?: number };
  const logs = String(await c.logs({ stdout: true, stderr: true }).catch(() => ''));
  await c.remove({ force: true }).catch(() => undefined);
  if (res.StatusCode === 3) return false;
  if (res.StatusCode !== 0) throw new Error(`litestream restore failed: ${logs.slice(-800)}`);
  return true;
}

/** Converge the container onto `spec`. Restart only when the image or config changed. */
async function converge(docker: DockerClient, spec: MeshControlSpec): Promise<MeshControlStatus> {
  const d = docker.docker;
  const cur = await inspectOrNull(docker, MESH_CONTROL_CONTAINER);
  const wantHash = sha256(spec.configYaml);
  if (controlNeedsRecreate(cur, spec.image)) {
    await docker.pullImage(spec.image).catch(() => undefined);
    await createControl(docker, spec);
  } else if (!cur?.State?.Running) {
    await d.getContainer(MESH_CONTROL_CONTAINER).start().catch(() => undefined);
  }
  // Persist FIRST: the restart below re-seeds the tmpfs from this copy.
  await persistConfig(docker, spec);
  // Also after a fresh create: its entrypoint may already have seeded the copy
  // as it was BEFORE persistConfig (an image change) — then this restarts it.
  const have = await configHashInside(docker);
  if (have !== wantHash) {
    if (have) {
      // The server doesn't re-read its config: restart, then hand it the new one.
      await d.getContainer(MESH_CONTROL_CONTAINER).restart({ t: 10 });
    }
    if (spec.caPem) await writeInto(docker, MESH_CONTROL_CONTAINER, `${CONFIG_DIR}/extra-ca.pem`, spec.caPem);
    await writeInto(docker, MESH_CONTROL_CONTAINER, CONFIG_FILE, spec.configYaml);
  }
  const litestream = await ensureLitestream(docker, spec).catch((e: unknown) => ({
    running: false,
    lastError: e instanceof Error ? e.message : String(e),
  }));
  return statusOf(docker, { litestream });
}

async function statusOf(docker: DockerClient, extra: Partial<MeshControlStatus> = {}): Promise<MeshControlStatus> {
  const cur = await inspectOrNull(docker, MESH_CONTROL_CONTAINER);
  if (!cur) return { running: false, healthy: false, waitingForConfig: false, ...extra };
  const running = !!cur.State?.Running;
  const hash = running ? await configHashInside(docker) : null;
  const ls = extra.litestream ?? (await inspectOrNull(docker, MESH_LITESTREAM_CONTAINER).then((c) => (c ? { running: !!c.State?.Running } : undefined)));
  return {
    running,
    healthy: running && hash ? await healthy(docker) : false,
    image: cur.Config?.Labels?.[IMAGE_LABEL] ?? cur.Config?.Image,
    configHash: hash ?? undefined,
    waitingForConfig: running && !hash,
    startedAt: cur.State?.StartedAt,
    ...(ls ? { litestream: ls } : {}),
    ...extra,
  };
}

/** The `applyMeshControl` command. */
export async function applyMeshControl(docker: DockerClient, p: ApplyMeshControlPayload): Promise<MeshControlStatus> {
  if (p.action === 'status') return statusOf(docker);
  if (p.action === 'stop') {
    // Fence: stop the server (and its replica writer), forget the local copy
    // so a reboot doesn't bring an old control plane back. The volume stays.
    await docker.docker.getContainer(MESH_LITESTREAM_CONTAINER).remove({ force: true }).catch(() => undefined);
    await docker.docker.getContainer(MESH_CONTROL_CONTAINER).remove({ force: true }).catch(() => undefined);
    // …and the persisted copy a reboot would seed an old control plane from.
    await docker.docker.getVolume(MESH_CONTROL_CONF_VOLUME).remove().catch(() => undefined);
    await ensureMeshFront(docker, null, logFront);
    await forgetLocal();
    return { running: false, healthy: false, waitingForConfig: false };
  }
  if (!p.spec) throw new Error(`applyMeshControl ${p.action} needs a spec`);
  let restored: boolean | undefined;
  if (p.action === 'restore') {
    await docker.docker.getContainer(MESH_CONTROL_CONTAINER).remove({ force: true }).catch(() => undefined);
    restored = await restoreInto(docker, p.spec);
  }
  await saveLocal(p.spec);
  const st = await converge(docker, p.spec);
  return restored === undefined ? st : { ...st, restored };
}

let supervising = false;
const logFront = (m: string) => console.log(`[swarmy-agent] ${m}`);
let lastFirewallAt = 0;
const MESH_FIREWALL_EVERY_MS = 5 * 60_000;
/**
 * The 10 s supervisor (daemon.ts), independent of the controller connection:
 * if this node holds a control-plane spec, keep the container running and its
 * tmpfs config present. Never throws.
 */
export async function superviseMeshControl(docker: DockerClient): Promise<MeshControlStatus | null> {
  if (!env.ALLOW_MESH || supervising) return null;
  supervising = true;
  try {
    const spec = await loadLocalSpec();
    if (!spec) {
      // A front left from a control plane that moved away.
      if (await inspectOrNull(docker, MESH_FRONT_CONTAINER)) await ensureMeshFront(docker, null, logFront);
      return null;
    }
    const st = await converge(docker, spec);
    // QA-066 (f): this node's mesh client must reach signal without the swarm edge.
    await ensureMeshFront(docker, spec.configYaml, logFront);
    // QA-014: metrics / legacy gRPC / health never answer off-host.
    if (Date.now() - lastFirewallAt > MESH_FIREWALL_EVERY_MS) {
      lastFirewallAt = Date.now();
      const fw = await enforceMeshFirewall(docker, agentPackaging());
      if (fw.status === 'failed') console.warn(`[swarmy-agent] mesh control-plane firewall failed: ${fw.detail ?? ''}`);
    }
    return st;
  } catch (e) {
    return { running: false, healthy: false, waitingForConfig: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    supervising = false;
  }
}

/** For the meshState sampler: status only when this node hosts the control plane. */
export async function sampleMeshControl(docker: DockerClient): Promise<MeshControlStatus | undefined> {
  const cur = await inspectOrNull(docker, MESH_CONTROL_CONTAINER);
  if (!cur) return undefined;
  return statusOf(docker).catch(() => undefined);
}
