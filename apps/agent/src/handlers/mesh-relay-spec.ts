/**
 * Pure parts of the edge relay (`swarmy-mesh-relay`, see mesh-relay.ts): the
 * entrypoint, the tmpfs env file and the container-level label. Checked
 * against the real `ghcr.io/netbirdio/relay:0.79.0` image (distroless
 * `:debug`, busybox at /busybox): the entrypoint waits for the env file,
 * exports it and execs the relay as PID 1; flags come from `NB_*` env
 * (`setFlagsFromEnvVars`).
 */
import { createHash } from 'node:crypto';
import type { MeshRelaySpec } from '@swarmy/core/protocol';

export const MESH_RELAY_CONTAINER = 'swarmy-mesh-relay';
export const MESH_RELAY_ENV_DIR = '/run/swarmy-relay';
export const MESH_RELAY_ENV_FILE = `${MESH_RELAY_ENV_DIR}/env`;
/** sha256 of image + entrypoint: a change re-creates the container (a config change only restarts it). */
export const MESH_RELAY_CONTAINER_LABEL = 'swarmy.mesh.relay.container';

export const MESH_RELAY_ENTRYPOINT = [
  '/busybox/sh',
  '-c',
  `while [ ! -s ${MESH_RELAY_ENV_FILE} ]; do sleep 0.2; done; set -a; . ${MESH_RELAY_ENV_FILE}; set +a; exec /go/bin/netbird-relay`,
];

/** POSIX single quotes (the spec schema already refuses newlines and NUL). */
export function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** The env file the entrypoint sources: every relay flag, the secret included. Deterministic. */
export function renderRelayEnv(spec: MeshRelaySpec): string {
  const vars: [string, string][] = [
    ['NB_LISTEN_ADDRESS', `:${spec.listenPort}`],
    ['NB_EXPOSED_ADDRESS', spec.exposedAddress],
    ['NB_AUTH_SECRET', spec.authSecret],
    ['NB_METRICS_PORT', String(spec.metricsPort)],
    // Loopback: the relay's /health is a TLS check (503 behind the edge), only for us.
    ['NB_HEALTH_LISTEN_ADDRESS', `127.0.0.1:${spec.healthPort}`],
    ['NB_LOG_LEVEL', 'info'],
    ['NB_ENABLE_STUN', spec.stun ? 'true' : 'false'],
    ['NB_STUN_PORTS', String(spec.stunPort)],
  ];
  return vars.map(([k, v]) => `${k}=${shQuote(v)}`).join('\n') + '\n';
}

export function relayContainerLabel(image: string): string {
  return createHash('sha256').update(JSON.stringify({ image, entrypoint: MESH_RELAY_ENTRYPOINT })).digest('hex');
}

/** Pure: must the running container be re-created for `image`? */
export function relayNeedsRecreate(cur: { Config?: { Labels?: Record<string, string> | null } } | null, image: string): boolean {
  return !cur || cur.Config?.Labels?.[MESH_RELAY_CONTAINER_LABEL] !== relayContainerLabel(image);
}
