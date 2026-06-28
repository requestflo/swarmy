import type { DemoStore, DomainResolvers } from '../types';

/**
 * Mesh demo resolvers — the Networking surface's zero-trust networking half:
 * driver chooser + master switch, control-plane config, node enrollment + the
 * live peer list, and direct-connect routes (grant/revoke). Covers the `mesh`
 * router and its nested `mesh.routes` router.
 *
 * State lives in `store.extra.mesh`; mutations flip booleans / push rows so the
 * page reflects changes after it invalidates and re-reads (the peer list polls
 * every 10s, routes every 15s). Demo mode has no vault, so we never keep real
 * secrets — `tokenConfigured` is just a flag the way the real `MeshConfigView`
 * (which never returns the token) reports it. Seeded to be coherent with the
 * cluster in data.ts (nodes n-mgr-1/n-wkr-1/…, services svc-postgres/svc-api/…).
 */

/** Driver ids the UI offers (mirrors `MeshDriverId` in mesh-driver-card.tsx). */
type MeshDriverId = 'none' | 'netbird' | 'headscale' | 'tailscale' | 'wireguard';

/** Mirror of the controller's `MeshConfigView` (mesh.service.ts). */
interface MeshConfigView {
  driver: MeshDriverId;
  enabled: boolean;
  managementUrl: string | null;
  controlPlaneMode: 'managed-by-swarmy' | 'external';
  /** Whether a control-plane service token is stored (secret never returned). */
  tokenConfigured: boolean;
  peerCount: number;
  updatedAt: string;
}

/** Mirror of the controller's `MeshPeerView` (mesh.service.ts). */
interface MeshPeerView {
  id: string;
  nodeId: string;
  meshIp: string | null;
  status: string;
  lastSeen: string | null;
}

/** Mirror of the controller's `MeshRouteView` (mesh.service.ts). */
interface MeshRouteView {
  id: string;
  kind: string;
  targetServiceId: string | null;
  targetStackId: string | null;
  cidr: string | null;
  port: number | null;
  principalType: string;
  principalId: string;
  expiresAt: string | null;
  createdAt: string;
}

/** Mirror of the controller's `DirectConnectInfo` (mesh.service.ts). */
interface DirectConnectInfo {
  driver: MeshDriverId;
  /** `<meshIp>:<port>` the principal dials. */
  address: string;
  /** Copy-paste snippet to join as an ephemeral peer scoped to the route. */
  joinSnippet: string;
  setupKey?: string;
}

/** The demo mesh world: org config, control plane, peers and direct routes. */
interface MeshState {
  driver: MeshDriverId;
  enabled: boolean;
  managementUrl: string | null;
  controlPlaneMode: 'managed-by-swarmy' | 'external';
  /** Has a service/auth token on file (we never store the value itself). */
  tokenConfigured: boolean;
  updatedAt: string;
  peers: MeshPeerView[];
  routes: MeshRouteView[];
}

const VALID_DRIVERS: ReadonlySet<MeshDriverId> = new Set<MeshDriverId>([
  'none',
  'netbird',
  'headscale',
  'tailscale',
  'wireguard',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function isoAgo(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function getState(store: DemoStore): MeshState {
  return store.extra.mesh as MeshState;
}

/** Build the summary view the Networking page header + badges + cards read. */
function toConfigView(st: MeshState): MeshConfigView {
  return {
    driver: st.driver,
    enabled: st.enabled,
    managementUrl: st.managementUrl,
    controlPlaneMode: st.controlPlaneMode,
    tokenConfigured: st.tokenConfigured,
    peerCount: st.peers.length,
    updatedAt: st.updatedAt,
  };
}

/** Next free mesh IP in the 100.92.0.0/16 NetBird-style range, by peer count. */
function nextMeshIp(st: MeshState): string {
  return `100.92.0.${10 + st.peers.length}`;
}

/** The join snippet a principal would paste, shaped per driver (see mesh.service). */
function joinSnippet(driver: MeshDriverId, url: string, setupKey: string): string {
  if (driver === 'netbird') {
    return `netbird up --management-url ${url || 'https://netbird.northwind.dev'} --setup-key ${setupKey}`;
  }
  if (driver === 'headscale' || driver === 'tailscale') {
    return `tailscale up --login-server ${url || 'https://controlplane.tailscale.com'} --authkey ${setupKey}`;
  }
  return `# add this machine as a WireGuard peer, then: wg-quick up wg0`;
}

export const mesh: DomainResolvers = {
  handlers: {
    'mesh.getConfig': (_i, s): MeshConfigView => toConfigView(getState(s)),

    'mesh.listDrivers': (): MeshDriverId[] => ['none', 'netbird', 'headscale', 'tailscale', 'wireguard'],

    'mesh.listPeers': (_i, s): MeshPeerView[] => getState(s).peers,

    'mesh.setDriver': (i, s): MeshConfigView => {
      const { driver } = i as { driver: MeshDriverId };
      const st = getState(s);
      if (VALID_DRIVERS.has(driver)) st.driver = driver;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'mesh.setEnabled': (i, s): MeshConfigView => {
      const { enabled } = i as { enabled: boolean };
      const st = getState(s);
      st.enabled = enabled;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'mesh.setControlPlane': (i, s): MeshConfigView => {
      const input = i as
        | { mode: 'managed-by-swarmy' | 'external'; managementUrl?: string; serviceToken?: string }
        | null;
      const st = getState(s);
      if (input == null) {
        // Clearing the control plane.
        st.controlPlaneMode = 'external';
        st.managementUrl = null;
        st.tokenConfigured = false;
      } else {
        st.controlPlaneMode = input.mode;
        st.managementUrl = input.managementUrl ?? st.managementUrl;
        // A token only sets the flag; we never keep the value (mirrors the view).
        if (input.serviceToken) st.tokenConfigured = true;
      }
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'mesh.enrollNode': (i, s): MeshPeerView => {
      const b = i as { nodeId: string; advertiseRoutes?: string[] };
      const st = getState(s);
      const existing = st.peers.find((p) => p.nodeId === b.nodeId);
      if (existing) {
        // Re-enroll: bump it back to ENROLLING and refresh last-seen.
        existing.status = 'ENROLLING';
        existing.meshIp = existing.meshIp ?? nextMeshIp(st);
        existing.lastSeen = nowIso();
        st.updatedAt = nowIso();
        return existing;
      }
      const peer: MeshPeerView = {
        id: rid('peer'),
        nodeId: b.nodeId,
        meshIp: nextMeshIp(st),
        status: 'ENROLLING',
        lastSeen: nowIso(),
      };
      // Newest first, matching the controller's `orderBy: createdAt desc`.
      st.peers = [peer, ...st.peers];
      st.updatedAt = nowIso();
      return peer;
    },

    'mesh.routes.list': (_i, s): MeshRouteView[] => getState(s).routes,

    'mesh.routes.preview': (i, s): { kind: string; summary: string; rendered?: string } => {
      const b = (i as { port?: number; proto?: 'tcp' | 'udp' } | undefined) ?? {};
      const st = getState(s);
      if (st.driver === 'netbird' || st.driver === 'headscale') {
        return {
          kind: 'control-plane',
          summary: `Would push ${st.routes.length + 1} policy / 2 group changes`,
          rendered: JSON.stringify(
            {
              groups: [`swarmy-principal-${rid('p')}`, `swarmy-target-${rid('t')}`],
              policies: [{ name: `direct-${rid('r')}`, port: b.port ?? null, proto: b.proto ?? 'tcp' }],
            },
            null,
            2,
          ),
        };
      }
      if (st.driver === 'wireguard') {
        return {
          kind: 'file',
          summary: 'Would write /etc/wireguard/wg0.conf',
          rendered: `[Peer]\nAllowedIPs = 100.92.0.0/24\n# port ${b.port ?? 'any'} / ${b.proto ?? 'tcp'}`,
        };
      }
      return { kind: 'none', summary: 'No access enforcement for this driver.' };
    },

    'mesh.routes.grant': (i, s): { route: MeshRouteView; connect: DirectConnectInfo } => {
      const b = i as {
        serviceId?: string;
        stackId?: string;
        principalType?: 'peer' | 'group' | 'member';
        principalId: string;
        port?: number;
        proto?: 'tcp' | 'udp';
        ttlSec?: number;
      };
      const st = getState(s);
      const route: MeshRouteView = {
        id: rid('route'),
        kind: 'direct',
        targetServiceId: b.serviceId ?? null,
        targetStackId: b.stackId ?? null,
        cidr: null,
        port: b.port ?? null,
        principalType: b.principalType ?? 'peer',
        principalId: b.principalId,
        expiresAt: b.ttlSec ? isoAgo(-b.ttlSec * 1000) : null,
        createdAt: nowIso(),
      };
      // Newest first, matching the controller's `orderBy: createdAt desc`.
      st.routes = [route, ...st.routes];
      st.updatedAt = nowIso();

      // Resolve the target's mesh host: if the service sits on an enrolled node,
      // dial that peer's mesh IP; else a generic mesh hostname.
      let host = 'svc.mesh';
      if (b.serviceId) {
        const svc = s.services.find((sv) => sv.id === b.serviceId);
        if (svc?.nodeId) {
          const peer = st.peers.find((p) => p.nodeId === svc.nodeId);
          if (peer?.meshIp) host = peer.meshIp;
        }
      }
      const address = b.port ? `${host}:${b.port}` : host;
      const setupKey = rid('msh');
      return {
        route,
        connect: {
          driver: st.driver,
          address,
          joinSnippet: joinSnippet(st.driver, st.managementUrl ?? '', setupKey),
          setupKey,
        },
      };
    },

    'mesh.routes.revoke': (i, s): { id: string; removed: true } => {
      const { routeId } = i as { routeId: string };
      const st = getState(s);
      st.routes = st.routes.filter((r) => r.id !== routeId);
      st.updatedAt = nowIso();
      return { id: routeId, removed: true };
    },
  },

  seed: (store) => {
    // A coherent slice of the demo cluster: NetBird live, the manager pair plus
    // two workers meshed (the draining wkr-3 not yet enrolled), pointed at a
    // managed control plane, with two direct routes — a laptop on Postgres and a
    // CI box on the API — both expiring shortly (data.ts ids).
    const state: MeshState = {
      driver: 'netbird',
      enabled: true,
      managementUrl: 'https://netbird.northwind.dev',
      controlPlaneMode: 'managed-by-swarmy',
      tokenConfigured: true,
      updatedAt: isoAgo(18 * MIN),
      peers: [
        { id: 'peer-mgr-1', nodeId: 'n-mgr-1', meshIp: '100.92.0.11', status: 'CONNECTED', lastSeen: isoAgo(4_000) },
        { id: 'peer-mgr-2', nodeId: 'n-mgr-2', meshIp: '100.92.0.12', status: 'CONNECTED', lastSeen: isoAgo(7_000) },
        { id: 'peer-wkr-1', nodeId: 'n-wkr-1', meshIp: '100.92.0.21', status: 'CONNECTED', lastSeen: isoAgo(12_000) },
        { id: 'peer-wkr-2', nodeId: 'n-wkr-2', meshIp: '100.92.0.22', status: 'ENROLLED', lastSeen: isoAgo(3 * MIN) },
      ],
      routes: [
        {
          id: 'route-pg',
          kind: 'direct',
          targetServiceId: 'svc-postgres',
          targetStackId: null,
          cidr: null,
          port: 5432,
          principalType: 'peer',
          principalId: 'laptop-calum',
          expiresAt: isoAgo(-45 * MIN),
          createdAt: isoAgo(15 * MIN),
        },
        {
          id: 'route-api',
          kind: 'direct',
          targetServiceId: 'svc-api',
          targetStackId: null,
          cidr: null,
          port: 8080,
          principalType: 'group',
          principalId: 'ci-runners',
          expiresAt: isoAgo(-2 * HOUR),
          createdAt: isoAgo(40 * MIN),
        },
      ],
    };
    store.extra.mesh = state;
  },
};
