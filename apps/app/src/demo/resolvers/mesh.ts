import type { DemoStore, DomainResolvers } from '../types';

/**
 * Mesh demo resolvers — the Networking surface's zero-trust networking half:
 * driver chooser + master switch, control-plane config, node enrollment and the
 * live peer list. Covers the `mesh` router.
 *
 * State lives in `store.extra.mesh`; mutations flip booleans / push rows so the
 * page reflects changes after it invalidates and re-reads (the peer list polls
 * every 10s). Demo mode has no vault, so we never keep real
 * secrets — `tokenConfigured` is just a flag the way the real `MeshConfigView`
 * (which never returns the token) reports it. Seeded to be coherent with the
 * cluster in data.ts (nodes n-mgr-1/n-wkr-1/…, services svc-postgres/svc-api/…).
 */

/** Driver ids the UI offers (mirrors `MeshDriverId` in mesh-driver-card.tsx). */
type MeshDriverId = 'none' | 'netbird' | 'headscale';

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

/** The demo mesh world: org config, control plane and peers. */
interface MeshState {
  driver: MeshDriverId;
  enabled: boolean;
  managementUrl: string | null;
  controlPlaneMode: 'managed-by-swarmy' | 'external';
  /** Has a service/auth token on file (we never store the value itself). */
  tokenConfigured: boolean;
  updatedAt: string;
  peers: MeshPeerView[];
}

const VALID_DRIVERS: ReadonlySet<MeshDriverId> = new Set<MeshDriverId>(['none', 'netbird', 'headscale']);

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

/** Demo people on the private network (mirror of `ConnectedPersonView`). */
const DEMO_PEOPLE = [
  { peerId: 'pp-calum', netbirdUserId: 'nb-calum', email: 'pilot@swarmy.dev', name: 'Demo Pilot', device: 'Pilot’s MacBook Pro', os: 'macOS 15', version: '0.36.5', meshIp: '100.92.4.31', connected: true, lastSeen: isoAgo(20_000), loginExpired: false, groups: ['swarmy:c1:access:storefront', 'swarmy:c1:access:data'], stacks: ['storefront', 'data'] },
  { peerId: 'pp-priya', netbirdUserId: 'nb-priya', email: 'priya@northwind.dev', name: 'Priya', device: 'Priya’s ThinkPad', os: 'Ubuntu 24.04', version: '0.36.5', meshIp: '100.92.4.32', connected: true, lastSeen: isoAgo(45_000), loginExpired: false, groups: ['swarmy:c1:access:storefront'], stacks: ['storefront'] },
  { peerId: 'pp-sam', netbirdUserId: 'nb-sam', email: 'sam@northwind.dev', name: 'Sam', device: 'Sam’s iPhone', os: 'iOS 18', version: '0.36.5', meshIp: '100.92.4.33', connected: false, lastSeen: isoAgo(2 * 60 * MIN), loginExpired: false, groups: ['swarmy:c1:access:platform'], stacks: ['platform'] },
];

export const mesh: DomainResolvers = {
  handlers: {
    'mesh.getConfig': (_i, s): MeshConfigView => toConfigView(getState(s)),

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

    // People access: the managed control plane, two laptops online, a phone asleep.
    'mesh.people.card': () => ({
      managed: true,
      settings: { enabled: true, loginExpiryHours: 8 },
      online: DEMO_PEOPLE.filter((p) => p.connected).length,
      devices: DEMO_PEOPLE.length,
      identity: 'People sign in through swarmy (and any SSO it is set up with). NetBird never sees a password.',
      plan: null,
    }),
    'mesh.people.connected': (i) => {
      const stack = (i as { stack?: string } | undefined)?.stack;
      return stack ? DEMO_PEOPLE.filter((p) => p.stacks.includes(stack)) : DEMO_PEOPLE;
    },
  },

  seed: (store) => {
    // A coherent slice of the demo cluster: NetBird live, the manager pair plus
    // two workers meshed (the draining wkr-3 not yet enrolled), pointed at a
    // managed control plane (data.ts ids).
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
    };
    store.extra.mesh = state;
  },
};
