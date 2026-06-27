/**
 * Mesh handler (epic: zero-trust-networking, MVP — NetBird default).
 *
 * Runs/joins the NetBird client container via dockerode using the driver-agnostic
 * {@link RenderedMesh} the controller produced (see `@swarmy/core/protocol`
 * `mesh.ts`). Mirrors `applyIngress` in executor.ts: it consumes a rendered
 * payload and applies it on the node — it never reasons about which provider it
 * is. The NetBird client is a long-lived, privileged sidecar (NET_ADMIN /
 * SYS_ADMIN / SYS_RESOURCE) that owns the WireGuard interface and dials out to
 * the management server — no inbound ports.
 *
 * Secrets (the single-use setup key) arrive over the authenticated WS and are
 * only ever the client container's env — never written to disk on the node.
 *
 * Gated by `SWARMY_ALLOW_MESH` (default on); the executor case rejects with
 * `E_MESH_DISABLED` when a node opts out (parity with `ALLOW_EXEC`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DockerClient } from '@swarmy/core/docker';
import type { ApplyMeshResult, RenderedMesh } from '@swarmy/core/protocol';

/** Default NetBird client image if the controller didn't pin one. */
const DEFAULT_NETBIRD_IMAGE = 'netbirdio/netbird:latest';
/** Stable name so re-applies reconcile the same container, never duplicate. */
const CONTAINER_NAME = 'swarmy-netbird';

async function execShell(cmd: string[]): Promise<void> {
  if (!cmd.length) return;
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}`);
}

/** Run / re-join the NetBird client container with the rendered enrollment. */
async function joinNetbird(
  docker: DockerClient,
  rendered: RenderedMesh,
): Promise<ApplyMeshResult> {
  const client = rendered.client;
  if (!client) throw new Error('netbird render is missing the client block');
  const image = client.image ?? DEFAULT_NETBIRD_IMAGE;
  const d = docker.docker;

  await docker.pullImage(image).catch(() => undefined);

  // Idempotent: recreate so re-applies pick up a fresh setup key / config and
  // never spin up a duplicate (mirrors the install-script reconcile pattern).
  await d.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => undefined);

  const env: string[] = [];
  if (client.setupKey) env.push(`NB_SETUP_KEY=${client.setupKey}`);
  if (client.managementUrl) env.push(`NB_MANAGEMENT_URL=${client.managementUrl}`);
  if (client.interface) env.push(`NB_INTERFACE_NAME=${client.interface}`);

  const container = await d.createContainer({
    name: CONTAINER_NAME,
    Image: image,
    Env: env,
    HostConfig: {
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped' },
      CapAdd: ['NET_ADMIN', 'SYS_ADMIN', 'SYS_RESOURCE'],
      // NetBird needs the tun device to build the WireGuard interface.
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
    },
  });
  await container.start();

  // Advertised subnet routes (best-effort; available once the client is up).
  if (client.advertiseRoutes.length) {
    await execShell([
      'docker',
      'exec',
      CONTAINER_NAME,
      'netbird',
      'routes',
      'add',
      ...client.advertiseRoutes,
    ]).catch(() => undefined);
  }

  return { driver: 'netbird', joined: true };
}

/** Tear the NetBird client down (action: 'leave'). */
async function leaveNetbird(docker: DockerClient): Promise<ApplyMeshResult> {
  await docker.docker.getContainer(CONTAINER_NAME).remove({ force: true }).catch(() => undefined);
  return { driver: 'netbird', joined: false };
}

/** Apply a rendered mesh membership on this node. */
export async function applyMesh(
  docker: DockerClient,
  rendered: RenderedMesh,
): Promise<ApplyMeshResult> {
  // Raw-WireGuard-style drivers may carry files + a reload command.
  for (const file of rendered.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, { mode: file.mode ?? 0o600 });
  }
  if (rendered.reloadCommand?.length) await execShell(rendered.reloadCommand);

  if (rendered.driver === 'none') {
    return { driver: 'none', joined: false };
  }
  if (rendered.action === 'leave') {
    return leaveNetbird(docker);
  }
  return joinNetbird(docker, rendered);
}
