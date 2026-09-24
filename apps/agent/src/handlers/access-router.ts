/**
 * People-access routers (plans/epic-self-hosted-mesh-and-fleets.md §3.3):
 * `swarmy-access-<stackId>` is a NetBird client attached ONLY to one stack's
 * overlay. It is the routing peer of that stack's NetBird Network, so traffic
 * from a permitted laptop exits it onto the overlay and reaches the service
 * VIP (swarm load-balances from there). It never joins `swarmy-control`
 * (refused below, as admission refuses it for user specs).
 *
 * The same container answers "what is the VIP of <svc>?" through Docker DNS on
 * that overlay, so the controller's DNS records follow redeploys without ever
 * storing a VIP (invariant 8).
 *
 * Gated by SWARMY_ALLOW_MESH (executor). NET_ADMIN + /dev/net/tun, like the
 * node sidecar — the privilege is the same, the blast radius is one overlay.
 */
import { DockerClient, defaultContainerLogConfig } from '@swarmy/core/docker';
import type { ApplyAccessRouterPayload, ApplyAccessRouterResult } from '@swarmy/core/protocol';
import { putSecretFile } from './secret-file';

const DEFAULT_IMAGE = 'netbirdio/netbird:0.79.0@sha256:9d8480d87b7f7c10d67b820eecf332ecca5c2756792d4bdfa532182b4fc3005f';
const FORBIDDEN_NETWORKS = new Set(['swarmy-control', 'host', 'bridge', 'none', 'ingress']);

export function accessRouterName(stackId: string): string {
  return `swarmy-access-${stackId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

async function execCapture(docker: DockerClient, name: string, cmd: string[]): Promise<{ code: number; stdout: string }> {
  const exec = await docker.docker.getContainer(name).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  let stdout = '';
  await new Promise<void>((resolve) => {
    const out = { write: (b: Buffer) => ((stdout += b.toString('utf8')), true) } as unknown as NodeJS.WritableStream;
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

/** Parse `getent ahostsv4 <name>` / `getent hosts` output → first IPv4. */
export function firstIpv4(out: string): string | undefined {
  for (const line of out.split('\n')) {
    const ip = line.trim().split(/\s+/)[0];
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return undefined;
}

async function resolveVips(docker: DockerClient, name: string, names: string[]): Promise<Record<string, string>> {
  const vips: Record<string, string> = {};
  for (const n of [...new Set(names)].sort()) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(n)) continue;
    const r = await execCapture(docker, name, ['getent', 'hosts', n]).catch(() => null);
    const ip = r && r.code === 0 ? firstIpv4(r.stdout) : undefined;
    if (ip) vips[n] = ip;
  }
  return vips;
}

async function meshIpOf(docker: DockerClient, name: string): Promise<{ connected: boolean; meshIp?: string }> {
  const r = await execCapture(docker, name, ['netbird', 'status', '--json']).catch(() => null);
  if (!r || r.code !== 0) return { connected: false };
  try {
    const j = JSON.parse(r.stdout) as { management?: { connected?: boolean }; netbirdIp?: string };
    return { connected: Boolean(j.management?.connected), meshIp: j.netbirdIp?.split('/')[0] || undefined };
  } catch {
    return { connected: false };
  }
}

export async function applyAccessRouter(docker: DockerClient, p: ApplyAccessRouterPayload): Promise<ApplyAccessRouterResult> {
  const name = accessRouterName(p.stackId);
  const d = docker.docker;
  if (p.action === 'down') {
    await d.getContainer(name).remove({ force: true }).catch(() => undefined);
    // Forget the peer identity: a later grant is a fresh router peer.
    await d.getVolume(name).remove().catch(() => undefined);
    return { running: false, connected: false, vips: {} };
  }
  if (FORBIDDEN_NETWORKS.has(p.network)) {
    throw new Error(`an access router may not join the ${p.network} network`);
  }

  const cur = await d
    .getContainer(name)
    .inspect()
    .catch(() => null);
  const onNetwork = !!cur?.NetworkSettings?.Networks?.[p.network];
  if (p.action === 'up' && (!cur || !onNetwork)) {
    if (!p.setupKey && !cur) throw new Error('first router start needs a setup key');
    const image = p.image ?? DEFAULT_IMAGE;
    await docker.pullImage(image).catch(() => undefined);
    await d.getContainer(name).remove({ force: true }).catch(() => undefined);
    const env = ['NB_INTERFACE_NAME=wt0', `NB_HOSTNAME=${name}`];
    if (p.managementUrl) env.push(`NB_MANAGEMENT_URL=${p.managementUrl}`);
    // A 0600 file on the router's own volume, never `-e` (docker inspect keeps env).
    if (p.setupKey) env.push('NB_SETUP_KEY_FILE=/var/lib/netbird/setup-key');
    try {
      const c = await d.createContainer({
        name,
        Hostname: name,
        Image: image,
        Env: env,
        Labels: { 'swarmy.managed': 'true', 'swarmy.role': 'access-router', 'swarmy.access.stack': p.stackId },
        HostConfig: {
          NetworkMode: p.network,
          RestartPolicy: { Name: 'unless-stopped' },
          LogConfig: defaultContainerLogConfig(),
          Binds: [`${name}:/var/lib/netbird`],
          CapAdd: ['NET_ADMIN', 'SYS_ADMIN', 'SYS_RESOURCE'],
          Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
          Sysctls: { 'net.ipv4.ip_forward': '1' },
        },
      });
      if (p.setupKey) await putSecretFile(c, '/var/lib/netbird', 'setup-key', `${p.setupKey}\n`);
      await c.start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not manually attachable/i.test(msg)) {
        return { running: false, connected: false, vips: {}, error: `network ${p.network} is not attachable` };
      }
      throw e;
    }
  } else if (cur && !cur.State?.Running) {
    await d.getContainer(name).start().catch(() => undefined);
  }

  const after = await d
    .getContainer(name)
    .inspect()
    .catch(() => null);
  if (!after?.State?.Running) return { running: false, connected: false, vips: {} };
  const [mesh, vips] = await Promise.all([meshIpOf(docker, name), resolveVips(docker, name, p.resolve)]);
  return { running: true, ...mesh, vips };
}
