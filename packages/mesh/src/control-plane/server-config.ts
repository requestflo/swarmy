/**
 * The self-hosted NetBird control plane's config file (plans/
 * epic-self-hosted-mesh-and-fleets.md §2.1, spike §11).
 *
 * Pure: swarmy renders `config.yaml` for the combined `netbird-server` and the
 * agent writes it into the container's tmpfs (never the image, the container
 * spec or the NetBird volume). JSON is valid YAML 1.2, so the file is emitted
 * as sorted, indented JSON: stable bytes, golden-testable, and go-yaml reads it.
 *
 * What the spike taught (all encoded here):
 *  - `disableDefaultPolicy` is NOT reachable in the combined server, so it is
 *    not rendered; the bootstrap deletes the Default policy instead.
 *  - `disableGeoliteUpdate` still downloads GeoLite on first boot; the
 *    container sets `NB_DISABLE_GEOLOCATION=true` ({@link MESH_CONTROL_ENV}).
 *  - `localAuthDisabled: true` refuses to start without another connector, so
 *    callers set it only once the swarmy connector exists.
 */

/** Where the server terminates TLS. */
export type MeshControlTls =
  /** NetBird's own ACME on :443 (HTTP-01 on :80): first boot on a public box. */
  | { mode: 'letsencrypt'; email?: string }
  /** Behind swarmy's edge Caddy: plain HTTP on the docker_gwbridge gateway. */
  | { mode: 'edge'; listen: string; /** Public https port of the fronting proxy (default 443). */ publicPort?: number }
  /** Lab / private network: plain HTTP on a port, no TLS at all. */
  | { mode: 'none'; port: number };

export interface MeshControlConfigInput {
  /** Public name peers dial, e.g. `mesh.example.com` (no scheme, no port). */
  meshDomain: string;
  tls: MeshControlTls;
  /** Relay shared secret (vault). */
  authSecret: string;
  /** Store column encryption key (vault, base64 32 bytes). */
  encryptionKey: string;
  /** Hide the local (password) login: only once the swarmy connector exists. */
  localAuthDisabled: boolean;
  /** STUN UDP port (default 3478). */
  stunPort?: number;
  /** CIDRs whose X-Forwarded-For is trusted (the edge's networks). */
  trustedProxies?: string[];
  logLevel?: 'info' | 'debug' | 'warn';
}

/** In-container paths (the agent owns both; see apps/agent handlers/mesh-control). */
export const MESH_CONTROL_CONFIG_DIR = '/run/swarmy-mesh';
export const MESH_CONTROL_CONFIG_PATH = `${MESH_CONTROL_CONFIG_DIR}/config.yaml`;
export const MESH_CONTROL_DATA_DIR = '/var/lib/netbird';
/**
 * The relay's health endpoint (`/health`). It checks the relay's TLS listener,
 * so it answers 503 whenever NetBird listens on plain HTTP (behind the edge, or
 * in a lab). Liveness is a TCP connect to the always-plain legacy gRPC port.
 */
export const MESH_CONTROL_HEALTH_PORT = 9000;
export const MESH_CONTROL_GRPC_LEGACY_PORT = 33073;
/** Default listen port behind the edge / in lab mode. */
export const MESH_CONTROL_HTTP_PORT = 8081;

/** Env the control-plane container always runs with (no secrets here). */
export const MESH_CONTROL_ENV: Readonly<Record<string, string>> = {
  NB_DISABLE_GEOLOCATION: 'true',
  GOMEMLIMIT: '192MiB',
};

/** The public base URL peers and browsers use (`https://mesh.x` or `http://mesh.x:8081`). */
export function meshControlPublicUrl(meshDomain: string, tls: MeshControlTls): string {
  if (tls.mode === 'none') return `http://${meshDomain}:${tls.port}`;
  if (tls.mode === 'edge' && tls.publicPort && tls.publicPort !== 443) return `https://${meshDomain}:${tls.publicPort}`;
  return `https://${meshDomain}`;
}

/** The embedded IdP's issuer (`<public>/oauth2`). */
export function meshControlIssuer(meshDomain: string, tls: MeshControlTls): string {
  return `${meshControlPublicUrl(meshDomain, tls)}/oauth2`;
}

/**
 * The redirect URI the swarmy OIDC client must allow: Dex uses one callback for
 * every connector (spike §11.4), not `/callback/<connector-id>`.
 */
export function meshControlOidcCallback(meshDomain: string, tls: MeshControlTls): string {
  return `${meshControlPublicUrl(meshDomain, tls)}/oauth2/callback`;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Render `config.yaml` for the combined NetBird server. Pure; throws on bad input. */
export function renderMeshControlConfig(input: MeshControlConfigInput): string {
  const domain = input.meshDomain.toLowerCase();
  if (!HOST_RE.test(domain)) throw new Error(`invalid mesh domain "${input.meshDomain}"`);
  if (input.authSecret.length < 16) throw new Error('authSecret must be at least 16 characters');
  if (Buffer.from(input.encryptionKey, 'base64').length !== 32) {
    // NetBird refuses to boot otherwise ("encryption key must be 32 bytes").
    throw new Error('encryptionKey must be base64 of exactly 32 bytes');
  }

  const tls = input.tls;
  const listenAddress =
    tls.mode === 'letsencrypt' ? ':443' : tls.mode === 'edge' ? tls.listen : `:${tls.port}`;
  const exposedAddress =
    tls.mode === 'none'
      ? `http://${domain}:${tls.port}`
      : `https://${domain}:${tls.mode === 'edge' ? (tls.publicPort ?? 443) : 443}`;

  const server: Record<string, unknown> = {
    listenAddress,
    exposedAddress,
    stunPorts: [input.stunPort ?? 3478],
    metricsPort: 9090,
    healthcheckAddress: `:${MESH_CONTROL_HEALTH_PORT}`,
    logLevel: input.logLevel ?? 'info',
    logFile: 'console',
    authSecret: input.authSecret,
    dataDir: `${MESH_CONTROL_DATA_DIR}/`,
    disableAnonymousMetrics: true,
    disableGeoliteUpdate: true,
    auth: {
      issuer: meshControlIssuer(domain, tls),
      localAuthDisabled: input.localAuthDisabled,
      signKeyRefreshEnabled: true,
      cliRedirectURIs: ['http://localhost:53000/', 'http://localhost:54000/'],
    },
    store: { engine: 'sqlite', encryptionKey: input.encryptionKey },
  };
  if (tls.mode === 'letsencrypt') {
    server.tls = {
      letsencrypt: {
        enabled: true,
        dataDir: `${MESH_CONTROL_DATA_DIR}/letsencrypt`,
        domains: [domain],
        ...(tls.email ? { email: tls.email } : {}),
      },
    };
  }
  if (input.trustedProxies?.length) {
    server.reverseProxy = { trustedHTTPProxies: [...input.trustedProxies].sort() };
  }
  return `# swarmy-managed NetBird control plane — rendered, do not edit.\n${JSON.stringify(sortKeys({ server }), null, 2)}\n`;
}
