/**
 * Keep a mesh node's swarm on the mesh across reboots (QA-059).
 *
 * The failure, reproduced on Lima: dockerd starts at boot before NetBird's wt0
 * exists (dockerd itself starts the netbird container). A swarm WORKER's local
 * address is not stored (`LocalAddr: ""` in docker-state.json); swarmkit
 * derives it from the route to the manager at start. Without wt0 that route is
 * the default route, so the node gossips its LAN/public IP. Encrypted-overlay
 * IPsec SAs get keyed to it (`ip xfrm state` → `src 192.168.64.15 dst 100.74…`)
 * while VXLAN leaves over wt0 with the mesh IP, and Docker's
 * `--pol none … vni … -j DROP` drops every encrypted overlay packet. A
 * `systemctl restart docker` does NOT reliably fix it (wt0 dies with dockerd
 * and comes back ~1 s after the swarm has re-derived the address).
 *
 * The fix (verified): pin the mesh route BEFORE docker starts. A tiny host
 * unit, `swarmy-mesh-pin.service` (Before=docker.service, and docker's drop-in
 * Wants+After it), puts the node's mesh IP on a dummy `swarmy-mesh0` and a
 * low-priority route for the mesh prefix through it with `src <mesh IP>`. The
 * route lookup to the manager then yields the mesh IP from the first second;
 * once wt0 is up its own (metric 0) route carries the traffic.
 *
 * Belt and braces: `checkOverlayKeying` watches the SAs, and if the local side
 * of any SA is not the mesh IP (twice in a row), restarts dockerd once (with
 * the pin in place a restart does fix it), at most once per 30 min.
 *
 * Runs on the host: natively for the binary agent (root), through a one-shot
 * `--pid host --privileged` nsenter container for the container agent. A host
 * without systemd (Docker Desktop) is skipped with a note.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DockerClient } from '@swarmy/core/docker';
import { env } from '../env';

export const MESH_PIN_UNIT = 'swarmy-mesh-pin.service';
export const MESH_PIN_IFACE = 'swarmy-mesh0';
/** Above anything NetBird installs (0), so wt0 always wins once it exists. */
export const MESH_PIN_METRIC = 4242;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** `100.74.144.211/16` → `{ ip: '100.74.144.211', prefix: '100.74.0.0/16' }`. Pure. */
export function meshPinFor(cidr: string | undefined): { ip: string; prefix: string } | null {
  if (!cidr) return null;
  const [ip, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!ip || !IPV4.test(ip) || !Number.isInteger(bits) || bits < 8 || bits > 30) return null;
  const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const net = (n & mask) >>> 0;
  const prefix = [24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.');
  return { ip, prefix: `${prefix}/${bits}` };
}

/** The pin itself (installed as /usr/local/lib/swarmy/mesh-pin.sh). Idempotent. */
export const MESH_PIN_SH = `#!/bin/sh
# swarmy: keep the swarm on the mesh across reboots (QA-059). Rendered by the agent.
set -u
[ -r /etc/swarmy/mesh-pin.env ] || exit 0
. /etc/swarmy/mesh-pin.env
[ -n "\${MESH_IP:-}" ] && [ -n "\${MESH_PREFIX:-}" ] || exit 0
ip link show ${MESH_PIN_IFACE} >/dev/null 2>&1 || ip link add ${MESH_PIN_IFACE} type dummy || exit 0
ip link set ${MESH_PIN_IFACE} up
for a in $(ip -4 -o addr show dev ${MESH_PIN_IFACE} | awk '{print $4}'); do
  [ "$a" = "\${MESH_IP}/32" ] || ip addr del "$a" dev ${MESH_PIN_IFACE}
done
ip addr show dev ${MESH_PIN_IFACE} | grep -q " \${MESH_IP}/32 " || ip addr add "\${MESH_IP}/32" dev ${MESH_PIN_IFACE}
ip route replace "\${MESH_PREFIX}" dev ${MESH_PIN_IFACE} src "\${MESH_IP}" metric ${MESH_PIN_METRIC}
exit 0
`;

export const MESH_PIN_SERVICE = `[Unit]
Description=swarmy: pin the mesh address before Docker (swarm stays on the mesh after a reboot)
DefaultDependencies=no
After=network-pre.target systemd-networkd.service NetworkManager.service
Before=docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/swarmy/mesh-pin.sh

[Install]
WantedBy=multi-user.target
`;

export const MESH_PIN_DOCKER_DROPIN = `# swarmy (QA-059): the mesh address must be routable before the swarm starts.
[Unit]
Wants=${MESH_PIN_UNIT}
After=${MESH_PIN_UNIT}
`;

/** Pure: the host script that installs + applies the pin for `pin`. */
export function renderMeshPinInstall(pin: { ip: string; prefix: string }): string {
  if (!IPV4.test(pin.ip) || !/^[\d.]+\/\d{1,2}$/.test(pin.prefix)) throw new Error('bad mesh pin');
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return `set -eu
command -v systemctl >/dev/null 2>&1 || { echo "swarmy-mesh-pin: no systemd"; exit 0; }
mkdir -p /etc/swarmy /usr/local/lib/swarmy /etc/systemd/system/docker.service.d
printf '%s' '${b64(`MESH_IP=${pin.ip}\nMESH_PREFIX=${pin.prefix}\n`)}' | base64 -d > /etc/swarmy/mesh-pin.env
printf '%s' '${b64(MESH_PIN_SH)}' | base64 -d > /usr/local/lib/swarmy/mesh-pin.sh
chmod 0755 /usr/local/lib/swarmy/mesh-pin.sh
printf '%s' '${b64(MESH_PIN_SERVICE)}' | base64 -d > /etc/systemd/system/${MESH_PIN_UNIT}
printf '%s' '${b64(MESH_PIN_DOCKER_DROPIN)}' | base64 -d > /etc/systemd/system/docker.service.d/10-swarmy-mesh-pin.conf
systemctl daemon-reload
systemctl enable ${MESH_PIN_UNIT} >/dev/null 2>&1 || true
/usr/local/lib/swarmy/mesh-pin.sh
echo "swarmy-mesh-pin: applied ${pin.ip} ${pin.prefix}"
`;
}

// ── host exec (native or nsenter sidecar) ─────────────────────────────────────

function inContainer(): boolean {
  return existsSync('/.dockerenv');
}

/** Run a POSIX-sh script in the host's namespaces. Never throws. */
export async function runOnHost(docker: DockerClient, script: string, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  try {
    if (!inContainer()) {
      if (process.getuid?.() !== 0) return { code: 1, out: 'not root' };
      const p = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
      const t = setTimeout(() => p.kill(), timeoutMs);
      const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(t);
      return { code, out: o + e };
    }
    const d = docker.docker;
    const self = (await d.getContainer(os.hostname()).inspect()) as { Image?: string };
    if (!self.Image) return { code: 1, out: 'cannot resolve the agent image' };
    const c = await d.createContainer({
      Image: self.Image,
      Entrypoint: ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', script],
      Cmd: [],
      Labels: { 'swarmy.managed': 'true', 'swarmy.role': 'host-exec' },
      HostConfig: { NetworkMode: 'host', PidMode: 'host', Privileged: true, AutoRemove: false },
    });
    const t = setTimeout(() => void c.kill().catch(() => undefined), timeoutMs);
    try {
      await c.start();
      const st = (await c.wait()) as { StatusCode?: number };
      const logs = await c.logs({ stdout: true, stderr: true });
      return { code: st.StatusCode ?? 1, out: logs.toString('utf8') };
    } finally {
      clearTimeout(t);
      await c.remove({ force: true }).catch(() => undefined);
    }
  } catch (e) {
    return { code: 1, out: e instanceof Error ? e.message : String(e) };
  }
}

// ── the loop hooks (daemon.ts, every meshState tick) ──────────────────────────

let appliedKey = '';
let appliedAt = 0;

/** Install/refresh the pin when the mesh address is known (idempotent; re-asserted every 30 min). */
export async function ensureMeshPin(docker: DockerClient, meshCidr: string | undefined, log: (m: string) => void): Promise<void> {
  const pin = meshPinFor(meshCidr);
  if (!pin) return;
  const key = `${pin.ip} ${pin.prefix}`;
  if (key === appliedKey && Date.now() - appliedAt < 30 * 60_000) return;
  const r = await runOnHost(docker, renderMeshPinInstall(pin));
  if (/swarmy-mesh-pin: applied/.test(r.out)) {
    if (key !== appliedKey) log(`mesh pin installed (${key}): the swarm stays on the mesh after a reboot`);
    appliedKey = key;
    appliedAt = Date.now();
  } else if (/no systemd/.test(r.out)) {
    appliedKey = key;
    appliedAt = Date.now();
    log('mesh pin skipped: no systemd on this host (overlay keying is watched instead)');
  } else {
    log(`mesh pin failed: ${r.out.trim().slice(-300)}`);
  }
}

/**
 * Pure: SAs whose LOCAL side is not the mesh IP. `xfrm` is `ip xfrm state`
 * output, `local` the host's IPv4 addresses.
 */
export function misKeyedSAs(xfrm: string, local: readonly string[], meshIp: string): string[] {
  const bad: string[] = [];
  for (const m of xfrm.matchAll(/^src (\S+) dst (\S+)/gm)) {
    const [, src, dst] = m;
    const mine = local.includes(src!) ? src! : local.includes(dst!) ? dst! : null;
    if (mine && mine !== meshIp) bad.push(`src ${src} dst ${dst}`);
  }
  return [...new Set(bad)];
}

let suspectSince = 0;
let lastCheckAt = 0;
const RESTART_STATE = () => path.join(path.dirname(env.STATE_PATH), 'mesh-pin-restart.json');

/**
 * Self-heal: if encrypted-overlay SAs are keyed to a non-mesh local address
 * while the swarm advertises the mesh IP, restart dockerd once (the pin makes
 * the restart stick). Two sightings ≥ 45 s apart, at most once per 30 min.
 */
export async function checkOverlayKeying(docker: DockerClient, meshIp: string | undefined, log: (m: string) => void): Promise<void> {
  if (!meshIp || Date.now() - lastCheckAt < 60_000) return;
  lastCheckAt = Date.now();
  const info = (await docker.docker.info().catch(() => null)) as { Swarm?: { NodeAddr?: string; LocalNodeState?: string } } | null;
  if (info?.Swarm?.LocalNodeState !== 'active' || info.Swarm.NodeAddr !== meshIp) return;
  const r = await runOnHost(docker, `ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1; echo ---; ip xfrm state 2>/dev/null | grep '^src'`, 30_000);
  if (r.code !== 0) return;
  const [addrs, xfrm = ''] = r.out.split('---');
  const bad = misKeyedSAs(xfrm, addrs!.split(/\s+/).filter(Boolean), meshIp);
  if (!bad.length) {
    suspectSince = 0;
    return;
  }
  if (!suspectSince) {
    suspectSince = Date.now();
    log(`overlay IPsec keyed off the mesh (${bad[0]}); re-checking before healing`);
    return;
  }
  if (Date.now() - suspectSince < 45_000) return;
  const prev = JSON.parse(await readFile(RESTART_STATE(), 'utf8').catch(() => '{}')) as { at?: number };
  if (prev.at && Date.now() - prev.at < 30 * 60_000) return;
  await mkdir(path.dirname(RESTART_STATE()), { recursive: true }).catch(() => undefined);
  await writeFile(RESTART_STATE(), JSON.stringify({ at: Date.now(), bad }), { mode: 0o600 }).catch(() => undefined);
  log(`overlay IPsec keyed off the mesh (${bad.join('; ')}): restarting dockerd once (QA-059 self-heal)`);
  suspectSince = 0;
  // Runs detached on the host: a container agent is restarted along with dockerd.
  // --no-block: queued in the host's systemd, so it survives this (container) agent going down with dockerd.
  await runOnHost(docker, `/usr/local/lib/swarmy/mesh-pin.sh 2>/dev/null; systemctl --no-block restart docker`, 15_000);
}
