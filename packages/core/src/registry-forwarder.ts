/**
 * The per-node registry forwarder (security review M16). PURE: the agent runs
 * it, the controller gates the registry's move onto it, and both read these
 * names from here.
 *
 * The built-in registry (`swarmy-registry`, htpasswd) and the Docker Hub
 * pull-through cache (`swarmy-registry-cache`) used to publish :5000/:5001 on
 * the swarm routing mesh. Every node's dockerd pulled `localhost:5000`, so the
 * registry's basic-auth login crossed the UNENCRYPTED `ingress` overlay to the
 * node running the registry task, and both ports listened on every interface.
 *
 * Now both services join only the encrypted, attachable `swarmy` overlay and
 * publish nothing. Each node runs `swarmy-registry-forwarder`: a plain
 * container (not a swarm task) on `swarmy` that publishes 127.0.0.1:5000 and
 * 127.0.0.1:5001 only. dockerd, the host-network builder and the
 * trivy/cosign/regctl one-shots keep using `localhost:5000` / `localhost:5001`;
 * the hop to the registry node rides IPsec.
 *
 * Why a container the agent supervises, not a global service: a swarm task on
 * the host network can't join an overlay, and swarm can't bind a published
 * port to 127.0.0.1 (H1's root cause). A plain container can do both. Its
 * restart policy brings it back with dockerd after a reboot, and the agent
 * re-asserts it on a timer. Neither needs the controller, so pulls don't.
 *
 * It runs Caddy (the BOM's pinned `caddy` image, which the edge and the mesh
 * front already use) as a plain HTTP reverse proxy. The registry API is HTTP
 * and the Host header passes through unchanged, so the registry still builds
 * `localhost:5000` upload URLs.
 */
import { SHARED_PLATFORM_NETWORK } from './network-policy';
import { pinnedTaggedRef } from './system-images';

export const REGISTRY_SERVICE = 'swarmy-registry';
export const REGISTRY_CACHE_SERVICE = 'swarmy-registry-cache';
export const REGISTRY_FORWARDER_CONTAINER = 'swarmy-registry-forwarder';
/** The encrypted, attachable platform overlay (the installer's `create_overlay swarmy`). */
export const REGISTRY_FORWARDER_NETWORK = SHARED_PLATFORM_NETWORK;
/** Container label holding a hash of the options it was created with (any change re-creates it). */
export const REGISTRY_FORWARDER_SPEC_LABEL = 'swarmy.registry.forwarder.spec';
export const REGISTRY_FORWARDER_BIND = '127.0.0.1';

/** Loopback port on every node → the swarm service it reaches over `swarmy`. */
export const REGISTRY_FORWARDS = [
  { port: 5000, upstream: `${REGISTRY_SERVICE}:5000` },
  { port: 5001, upstream: `${REGISTRY_CACHE_SERVICE}:5000` },
] as const;
/** The host ports the routing mesh used to publish (a service publishing one is still on the mesh). */
export const REGISTRY_HOST_PORTS: readonly number[] = REGISTRY_FORWARDS.map((f) => f.port);

/** The forwarder image: the BOM's digest-pinned Caddy. Pulled from upstream, never from the registry it fronts. */
export function registryForwarderImage(): string {
  return pinnedTaggedRef('caddy');
}

/**
 * The Caddyfile: one plain-HTTP site per port. No admin API, no ACME, no
 * autosave. `flush_interval -1` streams blobs instead of buffering them.
 */
export function renderForwarderCaddyfile(): string {
  const sites = REGISTRY_FORWARDS.map(
    (f) => `http://:${f.port} {\n\treverse_proxy ${f.upstream} {\n\t\tflush_interval -1\n\t}\n}`,
  );
  return ['{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n}', ...sites].join('\n') + '\n';
}

/** Writes the Caddyfile from env on every start (the root filesystem is read-only). */
const ENTRY_SCRIPT =
  'printf "%s" "$SWARMY_FORWARDER_CADDYFILE" > /tmp/Caddyfile && exec caddy run --adapter caddyfile --config /tmp/Caddyfile';

/** dockerode `createContainer` options (without the spec label and log config, which the agent adds). */
export interface ForwarderContainerOptions {
  name: string;
  Image: string;
  Entrypoint: string[];
  Cmd: string[];
  Env: string[];
  ExposedPorts: Record<string, Record<string, never>>;
  Labels: Record<string, string>;
  HostConfig: {
    NetworkMode: string;
    PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    RestartPolicy: { Name: 'always' };
    ReadonlyRootfs: boolean;
    Tmpfs: Record<string, string>;
    CapDrop: string[];
    CapAdd: string[];
    SecurityOpt: string[];
    Memory: number;
  };
}

/**
 * The forwarder container. Loopback-only port bindings (reached through
 * `docker_gwbridge`, like any overlay container's published port), restart
 * `always`, every capability dropped but the bind one Caddy's binary carries,
 * a read-only root and tmpfs for Caddy's scratch dirs.
 */
export function registryForwarderContainer(image: string = registryForwarderImage()): ForwarderContainerOptions {
  const key = (p: number) => `${p}/tcp`;
  return {
    name: REGISTRY_FORWARDER_CONTAINER,
    Image: image,
    Entrypoint: ['/bin/sh', '-c', ENTRY_SCRIPT],
    Cmd: [],
    Env: [`SWARMY_FORWARDER_CADDYFILE=${renderForwarderCaddyfile()}`],
    ExposedPorts: Object.fromEntries(REGISTRY_FORWARDS.map((f) => [key(f.port), {}])),
    Labels: { 'swarmy.managed': 'true', 'swarmy.role': 'registry-forwarder' },
    HostConfig: {
      NetworkMode: REGISTRY_FORWARDER_NETWORK,
      PortBindings: Object.fromEntries(
        REGISTRY_FORWARDS.map((f) => [key(f.port), [{ HostIp: REGISTRY_FORWARDER_BIND, HostPort: String(f.port) }]]),
      ),
      RestartPolicy: { Name: 'always' },
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,size=1m', '/data': 'rw,size=16m', '/config': 'rw,size=1m' },
      CapDrop: ['ALL'],
      CapAdd: ['NET_BIND_SERVICE'],
      SecurityOpt: ['no-new-privileges'],
      Memory: 256 * 1024 * 1024,
    },
  };
}

/** Why a forwarder start failed, in words an operator can act on. Pure. */
export function forwarderStartIssue(message: string): 'port-held' | 'no-network' | 'not-attachable' | 'other' {
  if (/address already in use|port is already allocated|bind for .* failed/i.test(message)) return 'port-held';
  if (/not manually attachable/i.test(message)) return 'not-attachable';
  if (/network .*not found|no such network/i.test(message)) return 'no-network';
  return 'other';
}
