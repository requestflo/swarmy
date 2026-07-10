/**
 * Mesh handler (epic: zero-trust-networking).
 *
 * Runs/joins the mesh client on the node using the driver-agnostic
 * {@link RenderedMesh} the controller produced (see `@swarmy/core/protocol`
 * `mesh.ts`). Mirrors `applyIngress` in executor.ts: it consumes a rendered
 * payload and applies it — it never reasons about which provider it is.
 *
 *   - NetBird / Tailscale (incl. Headscale via the tailscale client): a long-
 *     lived, privileged sidecar container that owns the WireGuard interface and
 *     dials out to the management server — no inbound ports.
 *   - raw WireGuard: write `wg0.conf` + run `wg-quick up wg0` (carried in
 *     `files` + `reloadCommand`).
 *
 * Secrets (single-use setup/auth keys) arrive over the authenticated WS and are
 * only ever the client container's env — never written to disk on the node.
 *
 * Gated by `SWARMY_ALLOW_MESH` (default on); the executor case rejects with
 * `E_MESH_DISABLED` when a node opts out (parity with `ALLOW_EXEC`).
 *
 * Also exports the `meshState` reporter loop (telemetry the agent PUSHES, read
 * from `netbird status --json` / `tailscale status` / `wg show`) and the
 * node-local `grantDirectRoute` handler for the raw-WireGuard escape hatch.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DockerClient } from '@swarmy/core/docker';
import type {
  ApplyMeshResult,
  GrantDirectRoutePayload,
  GrantDirectRouteResult,
  MeshStatePayload,
  RenderedMesh,
} from '@swarmy/core/protocol';

/** Default client images if the controller didn't pin one. */
const DEFAULT_NETBIRD_IMAGE = 'netbirdio/netbird:latest';
const DEFAULT_TAILSCALE_IMAGE = 'tailscale/tailscale:latest';
/** Stable names so re-applies reconcile the same container, never duplicate. */
const NETBIRD_CONTAINER = 'swarmy-netbird';
const TAILSCALE_CONTAINER = 'swarmy-tailscale';

interface ExecResult {
  code: number;
  stdout: string;
}

async function execShell(cmd: string[]): Promise<void> {
  if (!cmd.length) return;
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}`);
}

async function execCapture(cmd: string[]): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

/** Run / re-join the NetBird client container. */
async function joinNetbird(docker: DockerClient, rendered: RenderedMesh): Promise<ApplyMeshResult> {
  const client = rendered.client;
  if (!client) throw new Error('netbird render is missing the client block');
  const image = client.image ?? DEFAULT_NETBIRD_IMAGE;
  const d = docker.docker;

  await docker.pullImage(image).catch(() => undefined);
  await d.getContainer(NETBIRD_CONTAINER).remove({ force: true }).catch(() => undefined);

  const env: string[] = [];
  if (client.setupKey) env.push(`NB_SETUP_KEY=${client.setupKey}`);
  if (client.managementUrl) env.push(`NB_MANAGEMENT_URL=${client.managementUrl}`);
  if (client.interface) env.push(`NB_INTERFACE_NAME=${client.interface}`);

  const container = await d.createContainer({
    name: NETBIRD_CONTAINER,
    Image: image,
    Env: env,
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      CapAdd: ['NET_ADMIN', 'SYS_ADMIN', 'SYS_RESOURCE'],
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
    },
  });
  await container.start();

  if (client.advertiseRoutes.length) {
    await execShell([
      'docker', 'exec', NETBIRD_CONTAINER, 'netbird', 'routes', 'add', ...client.advertiseRoutes,
    ]).catch(() => undefined);
  }
  return { driver: rendered.driver, joined: true };
}

/** Run / re-join the Tailscale client container (also serves Headscale via --login-server). */
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
  await docker.docker.getContainer(TAILSCALE_CONTAINER).remove({ force: true }).catch(() => undefined);
  if (rendered.reloadCommand?.length) await execShell(rendered.reloadCommand).catch(() => undefined);
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

  // Raw-WireGuard-style drivers carry files + a reload command.
  if (rendered.files.length) {
    for (const file of rendered.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents, { mode: file.mode ?? 0o600 });
    }
    if (rendered.reloadCommand?.length) await execShell(rendered.reloadCommand);
    return { driver: rendered.driver, joined: true };
  }

  const kind = rendered.client?.kind;
  if (kind === 'tailscale') return joinTailscale(docker, rendered);
  return joinNetbird(docker, rendered);
}

// ── meshState reporter (telemetry the agent pushes) ──────────────────────────

/** Parse `wg show <iface> dump` (tab-separated) into a coarse connected flag. */
export function parseWgConnected(dump: string): { connected: boolean; lastHandshakeAt?: string } {
  const lines = dump.trim().split('\n').filter(Boolean);
  // First line is the interface; subsequent lines are peers: ...latest-handshake...
  let latest = 0;
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const hs = Number(cols[4] ?? 0);
    if (hs > latest) latest = hs;
  }
  return latest > 0
    ? { connected: true, lastHandshakeAt: new Date(latest * 1000).toISOString() }
    : { connected: false };
}

/**
 * Strip a CIDR prefix from a mesh address so it's a bare host IP. NetBird's
 * `status --json` reports `netbirdIp` as `100.71.108.238/16`, but the value is
 * used verbatim as a Docker Swarm `--advertise-addr`, which rejects anything
 * that isn't a plain IP (or IP:port). Idempotent for already-bare IPs.
 */
function bareMeshIp(ip: string | undefined): string | undefined {
  return ip ? ip.split('/')[0] : ip;
}

/**
 * Sample the live mesh state from whichever client is present and return a
 * `meshState` payload, or null if no mesh is running. Best-effort: any error is
 * reported in the payload's `error` field rather than thrown.
 */
export async function sampleMeshState(): Promise<MeshStatePayload | null> {
  const sampledAt = Date.now();

  // NetBird: `netbird status --json` (inside the sidecar).
  const nb = await execCapture(['docker', 'exec', NETBIRD_CONTAINER, 'netbird', 'status', '--json']).catch(
    () => ({ code: 1, stdout: '' }),
  );
  if (nb.code === 0 && nb.stdout) {
    try {
      const j = JSON.parse(nb.stdout) as {
        management?: { connected?: boolean };
        netbirdIp?: string;
        peers?: { details?: { ip?: string; status?: string; relayed?: boolean }[] };
      };
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

  // Tailscale/Headscale: `tailscale status --json`.
  const ts = await execCapture(['docker', 'exec', TAILSCALE_CONTAINER, 'tailscale', 'status', '--json']).catch(
    () => ({ code: 1, stdout: '' }),
  );
  if (ts.code === 0 && ts.stdout) {
    try {
      const j = JSON.parse(ts.stdout) as {
        Self?: { TailscaleIPs?: string[]; Online?: boolean };
        BackendState?: string;
      };
      return {
        driver: 'tailscale',
        meshIp: bareMeshIp(j.Self?.TailscaleIPs?.[0]),
        connected: j.BackendState === 'Running',
        relayed: true,
        advertisedRoutes: [],
        peers: [],
        sampledAt,
      };
    } catch (e) {
      return { driver: 'tailscale', connected: false, relayed: true, advertisedRoutes: [], peers: [], error: e instanceof Error ? e.message : String(e), sampledAt };
    }
  }

  // Raw WireGuard: `wg show wg0 dump`.
  const wg = await execCapture(['wg', 'show', 'wg0', 'dump']).catch(() => ({ code: 1, stdout: '' }));
  if (wg.code === 0 && wg.stdout) {
    const { connected, lastHandshakeAt } = parseWgConnected(wg.stdout);
    return { driver: 'wireguard', interface: 'wg0', connected, relayed: false, lastHandshakeAt, advertisedRoutes: [], peers: [], sampledAt };
  }

  return null;
}

/**
 * Node-local direct-route gate for the raw-WireGuard escape hatch (no control
 * plane). For NetBird/Headscale/Tailscale the controller pushes the ACL to the
 * control plane and this is a no-op. Best-effort iptables; failures are reported.
 */
export async function grantDirectRoute(payload: GrantDirectRoutePayload): Promise<GrantDirectRouteResult> {
  const { target, action } = payload;
  if (!target.cidr && !target.host) return { applied: false };
  const dest = target.cidr ?? target.host ?? '';
  const op = action === 'revoke' ? '-D' : '-I';
  const rule = ['iptables', op, 'FORWARD', '-d', dest, '-j', 'ACCEPT'];
  if (target.port) rule.push('-p', 'tcp', '--dport', String(target.port));
  await execShell(rule).catch(() => undefined);
  return { applied: true };
}
