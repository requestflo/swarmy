/**
 * Mesh handler (epic: zero-trust-networking).
 *
 * Runs/joins the mesh client on the node using the driver-agnostic
 * {@link RenderedMesh} the controller produced (see `@swarmy/core/protocol`
 * `mesh.ts`). Mirrors `applyIngress` in executor.ts: it consumes a rendered
 * payload and applies it — it never reasons about which provider it is.
 *
 *   - NetBird, or Headscale via the tailscale client: a long-lived, privileged
 *     sidecar container that owns the WireGuard interface and dials out to the
 *     management server — no inbound ports.
 *
 * Secrets (single-use setup/auth keys) arrive over the authenticated WS and are
 * only ever the client container's env — never written to disk on the node.
 *
 * Gated by `SWARMY_ALLOW_MESH` (default on); the executor case rejects with
 * `E_MESH_DISABLED` when a node opts out (parity with `ALLOW_EXEC`).
 *
 * Also exports the `meshState` reporter loop (telemetry the agent PUSHES, read
 * from `netbird status --json` / `tailscale status`).
 */
import { DockerClient, defaultContainerLogConfig } from '@swarmy/core/docker';
import type {
  ApplyMeshResult,
  MeshStatePayload,
  RenderedMesh,
} from '@swarmy/core/protocol';
import { sampleMeshControl } from './mesh-control';
import { putSecretFile } from './secret-file';

/** Default client images if the controller didn't pin one. */
const DEFAULT_NETBIRD_IMAGE = 'ghcr.io/netbirdio/netbird:0.79.0@sha256:9d8480d87b7f7c10d67b820eecf332ecca5c2756792d4bdfa532182b4fc3005f';
const DEFAULT_TAILSCALE_IMAGE = 'tailscale/tailscale:latest';
/** Stable names so re-applies reconcile the same container, never duplicate. */
const NETBIRD_CONTAINER = 'swarmy-netbird';
/** Named volume holding the NetBird client state (installer uses the same). */
const NETBIRD_STATE_VOLUME = 'swarmy-netbird';
const TAILSCALE_CONTAINER = 'swarmy-tailscale';
/** System roots + the client volume (where an extra CA is dropped). */
export const CA_CERT_DIRS = '/etc/ssl/certs:/var/lib/netbird';

interface ExecResult {
  code: number;
  stdout: string;
}

/**
 * `docker exec <container> <cmd…>` through the Docker API, not the CLI: the
 * installer's node #1 agent runs in a container with the socket but no docker
 * binary, so CLI execs silently failed there and the mesh IP never reached the
 * controller (verified live). Captures demuxed stdout.
 */
async function containerExecCapture(docker: DockerClient, container: string, cmd: string[]): Promise<ExecResult> {
  const exec = await docker.docker.getContainer(container).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  let stdout = '';
  await new Promise<void>((resolve) => {
    const out = { write: (b: Buffer) => { stdout += b.toString('utf8'); return true; } } as unknown as NodeJS.WritableStream;
    const err = { write: () => true } as unknown as NodeJS.WritableStream;
    (docker.docker.modem as unknown as {
      demuxStream(s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream): void;
    }).demuxStream(stream, out, err);
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
  const inspect = await exec.inspect();
  return { code: inspect.ExitCode ?? 1, stdout };
}

let samplerDocker: DockerClient | undefined;
function defaultDocker(): DockerClient {
  samplerDocker ??= new DockerClient();
  return samplerDocker;
}

/** Run / re-join the NetBird client container. */
async function joinNetbird(docker: DockerClient, rendered: RenderedMesh): Promise<ApplyMeshResult> {
  const client = rendered.client;
  if (!client) throw new Error('netbird render is missing the client block');
  const image = client.image ?? DEFAULT_NETBIRD_IMAGE;
  const d = docker.docker;

  // Already joined (installer node #1, a mesh-first join, a re-enroll from the
  // dashboard): keep it. Recreating the client re-registers it as a NEW peer
  // with a NEW mesh IP — and a swarm advertising the old one falls apart.
  const existing = await sampleMeshState(docker).catch(() => null);
  if (existing?.connected && existing.driver === 'netbird') {
    return { driver: rendered.driver, joined: true, meshIp: existing.meshIp, peerId: existing.peerId };
  }

  await docker.pullImage(image).catch(() => undefined);
  await d.getContainer(NETBIRD_CONTAINER).remove({ force: true }).catch(() => undefined);

  const env: string[] = [];
  // The single-use key is a 0600 file on the client's own volume, read via
  // NB_SETUP_KEY_FILE — never `-e`, which docker inspect would keep forever.
  if (client.setupKey) env.push(`NB_SETUP_KEY_FILE=/var/lib/netbird/setup-key`);
  if (client.managementUrl) env.push(`NB_MANAGEMENT_URL=${client.managementUrl}`);
  if (client.interface) env.push(`NB_INTERFACE_NAME=${client.interface}`);
  // A private CA joins the system roots (Go reads every file in SSL_CERT_DIR).
  if (client.caPem) env.push(`SSL_CERT_DIR=${CA_CERT_DIRS}`);

  const container = await d.createContainer({
    name: NETBIRD_CONTAINER,
    Image: image,
    Env: env,
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: defaultContainerLogConfig(),
      // Peer identity (WireGuard key + login) survives a container re-create,
      // so the node keeps its mesh IP. The spent one-off setup key sits next
      // to it as a root-only 0600 file (never in the env / docker inspect).
      Binds: [`${NETBIRD_STATE_VOLUME}:/var/lib/netbird`],
      CapAdd: ['NET_ADMIN', 'SYS_ADMIN', 'SYS_RESOURCE'],
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
    },
  });
  if (client.setupKey) await putSecretFile(container, '/var/lib/netbird', 'setup-key', `${client.setupKey}\n`);
  if (client.caPem) await putSecretFile(container, '/var/lib/netbird', 'swarmy-ca.pem', client.caPem);
  await container.start();

  if (client.advertiseRoutes.length) {
    await containerExecCapture(docker, NETBIRD_CONTAINER, ['netbird', 'routes', 'add', ...client.advertiseRoutes]).catch(
      () => undefined,
    );
  }
  return { driver: rendered.driver, joined: true };
}

/** Run / re-join the tailscale client container for Headscale (--login-server). */
async function joinTailscale(docker: DockerClient, rendered: RenderedMesh): Promise<ApplyMeshResult> {
  const client = rendered.client;
  if (!client) throw new Error('tailscale render is missing the client block');
  const image = client.image ?? DEFAULT_TAILSCALE_IMAGE;
  const d = docker.docker;

  await docker.pullImage(image).catch(() => undefined);
  await d.getContainer(TAILSCALE_CONTAINER).remove({ force: true }).catch(() => undefined);

  const env: string[] = ['TS_STATE_DIR=/var/lib/tailscale', 'TS_USERSPACE=false'];
  if (client.authKey) env.push(`TS_AUTHKEY=${client.authKey}`);
  const extraArgs: string[] = [];
  if (client.managementUrl) extraArgs.push(`--login-server=${client.managementUrl}`);
  if (client.acceptRoutes) extraArgs.push('--accept-routes');
  if (client.advertiseRoutes.length) extraArgs.push(`--advertise-routes=${client.advertiseRoutes.join(',')}`);
  if (extraArgs.length) env.push(`TS_EXTRA_ARGS=${extraArgs.join(' ')}`);

  const container = await d.createContainer({
    name: TAILSCALE_CONTAINER,
    Image: image,
    Env: env,
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: defaultContainerLogConfig(),
      CapAdd: ['NET_ADMIN', 'SYS_MODULE'],
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
    },
  });
  await container.start();
  return { driver: rendered.driver, joined: true };
}

/** Tear the mesh client(s) down (action: 'leave'). */
async function leaveMesh(docker: DockerClient, rendered: RenderedMesh): Promise<ApplyMeshResult> {
  await docker.docker.getContainer(NETBIRD_CONTAINER).remove({ force: true }).catch(() => undefined);
  // Leaving forgets the peer identity too: a later join is a fresh peer.
  await docker.docker.getVolume(NETBIRD_STATE_VOLUME).remove().catch(() => undefined);
  await docker.docker.getContainer(TAILSCALE_CONTAINER).remove({ force: true }).catch(() => undefined);
  return { driver: rendered.driver, joined: false };
}

/** Apply a rendered mesh membership on this node. */
export async function applyMesh(docker: DockerClient, rendered: RenderedMesh): Promise<ApplyMeshResult> {
  if (rendered.driver === 'none') {
    return { driver: 'none', joined: false };
  }
  if (rendered.action === 'leave') {
    return leaveMesh(docker, rendered);
  }

  const kind = rendered.client?.kind;
  if (kind === 'tailscale') return joinTailscale(docker, rendered);
  return joinNetbird(docker, rendered);
}

// ── meshState reporter (telemetry the agent pushes) ──────────────────────────

/**
 * Strip a CIDR prefix from a mesh address so it's a bare host IP. NetBird's
 * `status --json` reports `netbirdIp` as `100.71.108.238/16`, but the value is
 * used verbatim as a Docker Swarm `--advertise-addr`, which rejects anything
 * that isn't a plain IP (or IP:port). Idempotent for already-bare IPs.
 *
 * Empty ⇒ undefined: a NetBird client that is
 * connected but not yet addressed reports `netbirdIp: ""`, and an empty mesh IP
 * used to reach the controller, which then sent `advertiseAddr: ""` — a
 * swarmJoin the agent's own schema rejects, dropped 6/6 (QA-063).
 */
export function bareMeshIp(ip: string | undefined): string | undefined {
  return ip ? ip.split('/')[0] || undefined : undefined;
}

/**
 * Sample the live mesh state from whichever client is present and return a
 * `meshState` payload, or null if no mesh is running. Best-effort: any error is
 * reported in the payload's `error` field rather than thrown.
 */
export async function sampleMeshState(docker: DockerClient = defaultDocker()): Promise<MeshStatePayload | null> {
  const state = await sampleClientState(docker);
  // The node that hosts the self-hosted control plane reports it too, even
  // when its own client is down (that is when the card matters most).
  const control = await sampleMeshControl(docker).catch(() => undefined);
  if (!control) return state;
  return state
    ? { ...state, control }
    : { driver: 'netbird', connected: false, relayed: false, advertisedRoutes: [], peers: [], control, sampledAt: Date.now() };
}

/** The last `netbirdIp` with its prefix (`100.74.144.211/16`), for the reboot pin (mesh-pin.ts). */
let lastMeshCidr: string | undefined;
export function lastSampledMeshCidr(): string | undefined {
  return lastMeshCidr;
}

async function sampleClientState(docker: DockerClient): Promise<MeshStatePayload | null> {
  const sampledAt = Date.now();

  // NetBird: `netbird status --json` (inside the sidecar).
  const nb = await containerExecCapture(docker, NETBIRD_CONTAINER, ['netbird', 'status', '--json']).catch(
    () => ({ code: 1, stdout: '' }),
  );
  if (nb.code === 0 && nb.stdout) {
    try {
      const j = JSON.parse(nb.stdout) as {
        management?: { connected?: boolean };
        netbirdIp?: string;
        peers?: { details?: { ip?: string; status?: string; relayed?: boolean }[] };
      };
      lastMeshCidr = j.netbirdIp || undefined;
      const peers = (j.peers?.details ?? []).map((p) => ({
        meshIp: bareMeshIp(p.ip),
        connected: p.status === 'Connected',
        relayed: Boolean(p.relayed),
      }));
      return {
        driver: 'netbird',
        meshIp: bareMeshIp(j.netbirdIp),
        connected: Boolean(j.management?.connected),
        relayed: peers.some((p) => p.relayed),
        advertisedRoutes: [],
        peers,
        sampledAt,
      };
    } catch (e) {
      return { driver: 'netbird', connected: false, relayed: false, advertisedRoutes: [], peers: [], error: e instanceof Error ? e.message : String(e), sampledAt };
    }
  }

  // Headscale (tailscale client): `tailscale status --json`.
  const ts = await containerExecCapture(docker, TAILSCALE_CONTAINER, ['tailscale', 'status', '--json']).catch(
    () => ({ code: 1, stdout: '' }),
  );
  if (ts.code === 0 && ts.stdout) {
    try {
      const j = JSON.parse(ts.stdout) as {
        Self?: { TailscaleIPs?: string[]; Online?: boolean };
        BackendState?: string;
      };
      return {
        driver: 'headscale',
        meshIp: bareMeshIp(j.Self?.TailscaleIPs?.[0]),
        connected: j.BackendState === 'Running',
        relayed: true,
        advertisedRoutes: [],
        peers: [],
        sampledAt,
      };
    } catch (e) {
      return { driver: 'headscale', connected: false, relayed: true, advertisedRoutes: [], peers: [], error: e instanceof Error ? e.message : String(e), sampledAt };
    }
  }

  return null;
}
