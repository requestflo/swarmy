/**
 * Relays on edges (plans/epic-self-hosted-mesh-and-fleets.md §2.5, M3):
 * supervise `swarmy-mesh-relay`, NetBird's standalone relay + STUN, on this
 * edge's host network. Like `swarmy-mesh-control` it is NOT a swarm service
 * (it carries the traffic the swarm rides when two peers can't punch through).
 *
 * The spec (with the relay secret) arrives on `applyMeshRelay`; the agent
 * keeps a 0600 copy in its state dir and writes the env file into the
 * container's tmpfs via `docker exec`, so the secret is never in the image,
 * the container spec or `docker inspect`. The 10 s supervisor (daemon.ts)
 * restores it after a restart, with or without the controller.
 *
 * Gated by SWARMY_ALLOW_MESH (executor), like the node sidecar.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DockerClient, defaultContainerLogConfig } from '@swarmy/core/docker';
import { MeshRelaySpec, meshRelaySpecHash, type ApplyMeshRelayPayload, type MeshRelayStatus } from '@swarmy/core/protocol';
import { env } from '../env';
import { enforceMeshFirewall } from './mesh-firewall';
import { execIn, inspectOrNull, sha256, writeInto } from './mesh-control';
import {
  MESH_RELAY_CONTAINER as NAME,
  MESH_RELAY_CONTAINER_LABEL,
  MESH_RELAY_ENTRYPOINT,
  MESH_RELAY_ENV_DIR,
  MESH_RELAY_ENV_FILE,
  relayContainerLabel,
  relayNeedsRecreate,
  renderRelayEnv,
} from './mesh-relay-spec';
import { agentPackaging } from './update';

export const MESH_RELAY_FIREWALL_CHAIN = 'SWARMY-MESH-RELAY';

function stateFile(): string {
  return path.join(path.dirname(env.STATE_PATH), 'mesh-relay', 'spec.json');
}

async function saveLocal(spec: MeshRelaySpec): Promise<void> {
  await mkdir(path.dirname(stateFile()), { recursive: true, mode: 0o700 });
  await writeFile(stateFile(), JSON.stringify(spec), { mode: 0o600 });
}

export async function loadLocalRelaySpec(): Promise<MeshRelaySpec | null> {
  const raw = await readFile(stateFile(), 'utf8').catch(() => '');
  const parsed = raw ? MeshRelaySpec.safeParse(JSON.parse(raw)) : null;
  return parsed?.success ? parsed.data : null;
}

async function envHashInside(docker: DockerClient): Promise<string | null> {
  const r = await execIn(docker, NAME, ['sh', '-c', `[ -s ${MESH_RELAY_ENV_FILE} ] && sha256sum ${MESH_RELAY_ENV_FILE} | cut -d' ' -f1`]).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() || null : null;
}

async function create(docker: DockerClient, spec: MeshRelaySpec): Promise<void> {
  await docker.pullImage(spec.image).catch(() => undefined);
  await docker.docker.getContainer(NAME).remove({ force: true }).catch(() => undefined);
  const c = await docker.docker.createContainer({
    name: NAME,
    Image: spec.image,
    Entrypoint: MESH_RELAY_ENTRYPOINT,
    Cmd: [],
    Labels: { 'swarmy.managed': 'true', 'swarmy.role': 'mesh-relay', [MESH_RELAY_CONTAINER_LABEL]: relayContainerLabel(spec.image) },
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: defaultContainerLogConfig(),
      Tmpfs: { [MESH_RELAY_ENV_DIR]: 'rw,noexec,nosuid,size=1m,mode=0700' },
    },
  });
  await c.start();
}

/** Converge onto `spec`: re-create on an image change, restart on a config change only. */
async function converge(docker: DockerClient, spec: MeshRelaySpec): Promise<MeshRelayStatus> {
  const cur = await inspectOrNull(docker, NAME);
  if (relayNeedsRecreate(cur, spec.image)) await create(docker, spec);
  else if (!cur?.State?.Running) await docker.docker.getContainer(NAME).start().catch(() => undefined);
  const want = renderRelayEnv(spec);
  const have = await envHashInside(docker);
  if (have !== sha256(want)) {
    // The relay never re-reads its flags: restart (the tmpfs empties), then hand it the new file.
    if (have) await docker.docker.getContainer(NAME).restart({ t: 10 });
    await writeInto(docker, NAME, MESH_RELAY_ENV_FILE, want);
  }
  return relayStatus(docker, spec);
}

/** Live status. Healthy = the WebSocket listener accepts connections. */
export async function relayStatus(docker: DockerClient, spec?: MeshRelaySpec | null): Promise<MeshRelayStatus> {
  const cur = await inspectOrNull(docker, NAME);
  if (!cur) return { running: false, healthy: false };
  const running = Boolean(cur.State?.Running);
  const s = spec ?? (await loadLocalRelaySpec());
  const runsSpec = running && s ? (await envHashInside(docker)) === sha256(renderRelayEnv(s)) : false;
  const port = s?.listenPort ?? 33080;
  const probe = running ? await execIn(docker, NAME, ['nc', '-z', '127.0.0.1', String(port)]).catch(() => null) : null;
  return {
    running,
    healthy: Boolean(probe && probe.code === 0),
    ...(s ? { exposedAddress: s.exposedAddress, stun: s.stun } : {}),
    ...(runsSpec && s ? { specHash: meshRelaySpecHash(s) } : {}),
  };
}

/** The `applyMeshRelay` command. */
export async function applyMeshRelay(docker: DockerClient, p: ApplyMeshRelayPayload): Promise<MeshRelayStatus> {
  if (p.action === 'status') return relayStatus(docker);
  if (p.action === 'stop') {
    await docker.docker.getContainer(NAME).remove({ force: true }).catch(() => undefined);
    await rm(path.dirname(stateFile()), { recursive: true, force: true });
    return { running: false, healthy: false };
  }
  if (!p.spec) throw new Error('applyMeshRelay apply needs a spec');
  await saveLocal(p.spec);
  return converge(docker, p.spec);
}

let supervising = false;
let lastFirewallAt = 0;
/** The 10 s supervisor (daemon.ts): keep the relay this node holds a spec for running. Never throws. */
export async function superviseMeshRelay(docker: DockerClient): Promise<MeshRelayStatus | null> {
  if (!env.ALLOW_MESH || supervising) return null;
  supervising = true;
  try {
    const spec = await loadLocalRelaySpec();
    if (!spec) return null;
    const st = await converge(docker, spec);
    // Its plain listener and metrics bind every interface: only loopback, Docker and the mesh reach them.
    if (Date.now() - lastFirewallAt > 5 * 60_000) {
      lastFirewallAt = Date.now();
      const ports = [spec.listenPort, spec.metricsPort, spec.healthPort];
      await enforceMeshFirewall(docker, agentPackaging(), { ports, chain: MESH_RELAY_FIREWALL_CHAIN });
    }
    return st;
  } catch (e) {
    return { running: false, healthy: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    supervising = false;
  }
}

/** For the meshState sampler: only when this node runs a relay. */
export async function sampleMeshRelay(docker: DockerClient): Promise<MeshRelayStatus | undefined> {
  if (!(await inspectOrNull(docker, NAME))) return undefined;
  return relayStatus(docker).catch(() => undefined);
}
