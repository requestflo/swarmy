/**
 * A host-level TLS fallback for the mesh domain on the control-plane node
 * (QA-066 f).
 *
 * NetBird's client only brings wt0 up after it has logged in to management
 * AND dialled signal (client/internal/connect.go). Management hands out signal
 * and relay as `https://<mesh domain>:443`, and that name is served by the edge
 * Caddy on this node, which is a swarm task. After a reboot of a multi-manager
 * swarm, this node's manager sees no leader until the mesh is up, so it starts
 * no tasks: no edge, no signal (for this node's client or any other peer), no
 * wt0, no mesh, no leader. It never recovered on its own.
 *
 * `swarmy-mesh-front` breaks the cycle. It is a plain container on the host
 * network, started by dockerd with nothing on the swarm or an overlay. It runs
 * the same Caddy image as the edge, serving the edge's own node-local
 * certificate for the name (node-local first since QA-066) and proxying
 * exactly like the edge's mesh vhost to NetBird's listener on 127.0.0.1. It
 * listens on :18443, not :443: any socket on :443 (even 127.x) stops dockerd
 * from starting the edge's host-mode port (verified on Lima). Traffic to :443
 * reaches it through a nat chain (`SWARMY-MESH-FRONT`) jumped from the END of
 * PREROUTING and OUTPUT, AFTER Docker's own jump. While the edge runs,
 * Docker's DNAT claims :443 first and nothing changes. While it doesn't, :443
 * falls through to the front, for this node's client and for remote peers
 * alike. The jumps exist only while the front answers a TLS handshake for the
 * name, so :443 never falls into a black hole. The front exits when the edge
 * renews the certificate, and its restart policy serves the new one.
 */
import { connect } from 'node:tls';
import { DockerClient, defaultContainerLogConfig } from '@swarmy/core/docker';
import { runOnHost } from './mesh-pin';

export const MESH_FRONT_CONTAINER = 'swarmy-mesh-front';
/** The front's own port (never :443 — see above). */
export const MESH_FRONT_PORT = 18443;
export const MESH_FRONT_CHAIN = 'SWARMY-MESH-FRONT';
/** The edge's per-node data volume (packages/trpc ingress-controller DATA_VOLUME): its node-local certs. */
export const EDGE_DATA_VOLUME = 'swarmy-ingress-caddy-data';
const EDGE_SERVICE = 'swarmy-ingress-caddy';
const SPEC_LABEL = 'swarmy.mesh.front.spec';

export interface MeshFront {
  domain: string;
  port: number;
  upstream: string;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

/**
 * Pure: the front a rendered NetBird config needs, or null. Only behind the
 * edge (`exposedAddress` https, NetBird not terminating TLS itself).
 */
export function meshFrontFor(configYaml: string): MeshFront | null {
  let server: { exposedAddress?: unknown; listenAddress?: unknown; tls?: unknown };
  try {
    const json = configYaml.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    server = (JSON.parse(json) as { server?: typeof server }).server ?? {};
  } catch {
    return null;
  }
  if (server.tls || typeof server.exposedAddress !== 'string') return null;
  let u: URL;
  try {
    u = new URL(server.exposedAddress);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !DOMAIN.test(u.hostname)) return null;
  const listenPort = /:(\d+)$/.exec(typeof server.listenAddress === 'string' ? server.listenAddress : '')?.[1];
  if (!listenPort) return null;
  return { domain: u.hostname.toLowerCase(), port: Number(u.port || 443), upstream: `127.0.0.1:${listenPort}` };
}

/** Pure: the front's entrypoint (finds the edge's cert, serves, exits on renewal). */
export function renderFrontScript(f: MeshFront): string {
  const caddyfile = [
    '{',
    '  admin off',
    '  auto_https off',
    '  storage file_system /tmp/front/storage',
    '}',
    `https://${f.domain}:${MESH_FRONT_PORT} {`,
    '  tls /tmp/front/cert.crt /tmp/front/cert.key',
    // The edge's mesh vhost (packages/ingress caddyfile.ts buildControllerVhost).
    '  @grpc header Content-Type application/grpc*',
    `  reverse_proxy @grpc h2c://${f.upstream} {`,
    '    flush_interval -1',
    '    transport http {',
    '      read_timeout 24h',
    '      write_timeout 24h',
    '    }',
    '  }',
    `  reverse_proxy ${f.upstream} {`,
    '    flush_interval -1',
    '  }',
    '}',
  ].join('\n');
  return [
    'set -u',
    `d='${f.domain}'`,
    'find_crt() { ls /edge-data/caddy/certificates/*/"$d"/"$d".crt 2>/dev/null | head -n1; }',
    'crt=""; while [ -z "$crt" ]; do crt="$(find_crt)"; [ -n "$crt" ] || sleep 15; done',
    'mkdir -p /tmp/front && umask 077',
    'cp "$crt" /tmp/front/cert.crt && cp "${crt%.crt}.key" /tmp/front/cert.key || exit 1',
    `cat > /tmp/front/Caddyfile <<'SWARMY_FRONT_EOF'\n${caddyfile}\nSWARMY_FRONT_EOF`,
    'sum="$(cat "$crt" | sha256sum)"',
    'caddy run --config /tmp/front/Caddyfile --adapter caddyfile & pid=$!',
    // A renewed certificate: exit, and the restart policy serves the new one.
    'while kill -0 "$pid" 2>/dev/null; do sleep 300; now="$(find_crt)"; [ -n "$now" ] && [ "$(cat "$now" | sha256sum)" != "$sum" ] && { kill "$pid"; wait "$pid"; exit 0; }; done',
    'exit 1',
  ].join('\n');
}

/**
 * Pure: the host script that installs (serving) or removes the :443 → front
 * fallback. The jumps go at the END of PREROUTING / OUTPUT and are moved back
 * there if they ever sit before Docker's `-j DOCKER` (a dockerd restart
 * re-adds its own). Only the backend the kernel uses (the one with Docker's
 * nat chain) is touched.
 */
export function renderFrontFallback(f: MeshFront | null, serving: boolean): string {
  const C = MESH_FRONT_CHAIN;
  const port = f && Number.isInteger(f.port) && f.port > 0 && f.port < 65536 ? f.port : 443;
  const on = Boolean(f && serving);
  return `set -u
C=${C}
for ipt in iptables-legacy iptables-nft iptables; do
  command -v "$ipt" >/dev/null 2>&1 || continue
  "$ipt" -w -t nat -S DOCKER >/dev/null 2>&1 || continue
  for ch in PREROUTING OUTPUT; do
    while "$ipt" -w -t nat -C "$ch" -j "$C" >/dev/null 2>&1; do
      pos=$("$ipt" -w -t nat -S "$ch" | grep '^-A' | grep -n -- "-j $C\$" | head -n1 | cut -d: -f1)
      dpos=$("$ipt" -w -t nat -S "$ch" | grep '^-A' | grep -n -- '-j DOCKER$' | head -n1 | cut -d: -f1)
      if [ "${on ? 1 : 0}" = 1 ] && [ -n "$pos" ] && { [ -z "$dpos" ] || [ "$pos" -gt "$dpos" ]; }; then break; fi
      "$ipt" -w -t nat -D "$ch" -j "$C"
    done
  done
  if [ "${on ? 1 : 0}" = 1 ]; then
    "$ipt" -w -t nat -N "$C" >/dev/null 2>&1 || true
    "$ipt" -w -t nat -C "$C" -p tcp --dport ${port} -m addrtype --dst-type LOCAL -j REDIRECT --to-ports ${MESH_FRONT_PORT} >/dev/null 2>&1 || {
      "$ipt" -w -t nat -F "$C"
      "$ipt" -w -t nat -A "$C" -p tcp --dport ${port} -m addrtype --dst-type LOCAL -j REDIRECT --to-ports ${MESH_FRONT_PORT}
    }
    for ch in PREROUTING OUTPUT; do "$ipt" -w -t nat -C "$ch" -j "$C" >/dev/null 2>&1 || "$ipt" -w -t nat -A "$ch" -j "$C"; done
  else
    "$ipt" -w -t nat -F "$C" >/dev/null 2>&1 || true
    "$ipt" -w -t nat -X "$C" >/dev/null 2>&1 || true
  fi
  echo "swarmy-mesh-front-fallback: ${on ? 'on' : 'off'} ($ipt)"
done
true
`;
}

/** Does the front answer a TLS handshake for the name? */
function frontServes(f: MeshFront): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: MESH_FRONT_PORT, servername: f.domain, rejectUnauthorized: false, timeout: 3_000 });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once('secureConnect', () => done(true));
    s.once('error', () => done(false));
    s.once('timeout', () => done(false));
  });
}

/** The image the edge runs on this node (the front is the same Caddy build). */
async function edgeImage(docker: DockerClient): Promise<string | undefined> {
  const list = (await docker.docker
    .listContainers({ all: true, filters: { label: [`com.docker.swarm.service.name=${EDGE_SERVICE}`] } })
    .catch(() => [])) as { Image?: string; Created?: number }[];
  return list.sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0))[0]?.Image;
}

let fallbackState = '';

/** Converge the front + its :443 fallback for this node's control-plane spec. Never throws. */
export async function ensureMeshFront(docker: DockerClient, configYaml: string | null, log: (m: string) => void): Promise<void> {
  try {
    const f = configYaml ? meshFrontFor(configYaml) : null;
    const d = docker.docker;
    const cur = (await d
      .getContainer(MESH_FRONT_CONTAINER)
      .inspect()
      .catch(() => null)) as { Config?: { Labels?: Record<string, string> | null; Image?: string }; State?: { Running?: boolean } } | null;
    if (!f) {
      if (cur) await d.getContainer(MESH_FRONT_CONTAINER).remove({ force: true }).catch(() => undefined);
      await setFallback(docker, null, false, log);
      return;
    }
    const want = JSON.stringify(f);
    if (!cur || cur.Config?.Labels?.[SPEC_LABEL] !== want) {
      const image = (await edgeImage(docker)) ?? cur?.Config?.Image;
      if (!image) return; // no edge has run here yet: nothing to serve with
      await d.getContainer(MESH_FRONT_CONTAINER).remove({ force: true }).catch(() => undefined);
      const c = await d.createContainer({
        name: MESH_FRONT_CONTAINER,
        Image: image,
        Entrypoint: ['sh', '-c', renderFrontScript(f)],
        Cmd: [],
        Labels: { 'swarmy.managed': 'true', 'swarmy.role': 'mesh-front', [SPEC_LABEL]: want },
        HostConfig: {
          NetworkMode: 'host',
          RestartPolicy: { Name: 'always' },
          LogConfig: defaultContainerLogConfig(),
          Binds: [`${EDGE_DATA_VOLUME}:/edge-data:ro`],
        },
      });
      await c.start();
      log(`mesh front for ${f.domain} started (:${MESH_FRONT_PORT}): the mesh domain no longer needs the swarm edge on this node`);
    } else if (!cur.State?.Running) {
      await d.getContainer(MESH_FRONT_CONTAINER).start().catch(() => undefined);
    }
    await setFallback(docker, f, await frontServes(f), log);
  } catch (e) {
    log(`mesh front: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Re-asserted every 5 min even when unchanged: iptables rules do not survive
// a reboot, and a dockerd restart re-orders Docker's own jumps.
let fallbackAt = 0;
async function setFallback(docker: DockerClient, f: MeshFront | null, serving: boolean, log: (m: string) => void): Promise<void> {
  const key = `${f?.domain ?? ''}|${f?.port ?? ''}|${serving}`;
  if (key === fallbackState && Date.now() - fallbackAt < 5 * 60_000) return;
  const r = await runOnHost(docker, renderFrontFallback(f, serving), 20_000);
  if (!/swarmy-mesh-front-fallback: /.test(r.out)) return;
  if (key !== fallbackState && f) {
    log(serving ? `mesh front serving: :${f.port} falls back to it while the edge is down` : `mesh front not serving yet: no :${f.port} fallback`);
  }
  fallbackState = key;
  fallbackAt = Date.now();
}
