import type { DemoStore, DomainResolvers } from '../types';

/**
 * Geo-DNS demo resolvers — "swarmy is the nameserver" (apps/app Edge & ingress).
 *
 * Mirrors the reworked `geodns.*` router: zones are the registrar-facing
 * artifact (mode, pinned NS nodes, apex/www derivation), web records DERIVE
 * from the ingress domains seeded in `store.extra.ingress`, and manual records
 * cover MX/TXT/CNAME/SRV/CAA/NS. Return shapes mirror the controller views
 * exactly (GeoDnsConfigView, DnsZoneView, DnsViewRow, DelegationCheck,
 * ResolutionPreview, DnsRecordView, DomainCheck) so the dashboard renders
 * without surprises under ?demo=1.
 */

// ───────────────────────────────────────────── controller view mirrors ──

/** Mirror of `GeoDnsConfigView` (geodns.service.ts). */
interface GeoDnsConfigView {
  enabled: boolean;
  geoipSource: 'dbip' | 'maxmind' | 'file' | 'off';
  maxmindLicenseSecretRef?: string;
  mmdbConfigRef?: string;
  zoneCount: number;
  updatedAt: string;
}

/** Mirror of `DnsZoneView` (dns-zones.service.ts). */
interface DnsZoneView {
  id: string;
  zone: string;
  mode: string;
  enabled: boolean;
  ttl: number;
  serial: number;
  apexToEdge: boolean;
  autoWww: boolean;
  advertisedNodeIds: string[];
  nameservers: Array<{ label: string; fqdn: string; ip: string; nodeId: string; online: boolean }>;
  provider: { zoneId?: string; tokenEnv?: string; region?: string };
  conflicts?: Array<{ name: string; type: string; reason: string }>;
}

/** Mirror of `DnsRecordView` (dns-records.service.ts). */
interface DnsRecordView {
  id: string;
  zoneId: string;
  name: string;
  type: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

/** Mirror of `DnsViewRow` (geodns.service.ts). */
interface DnsViewRow {
  host: string;
  zone: string;
  source: string;
  stack?: string;
  endpoints: Array<{ region: string; ip: string; healthy: boolean }>;
  healthyCount: number;
}

// ───────────────────────────────────────────── demo world ──

interface ZoneState {
  id: string;
  zone: string;
  mode: string;
  enabled: boolean;
  ttl: number;
  serial: number;
  apexToEdge: boolean;
  autoWww: boolean;
  advertisedNodeIds: string[];
  provider: { zoneId?: string; tokenEnv?: string; region?: string };
}

/** The mutable demo world behind the Geo-DNS section. */
interface GeoState {
  enabled: boolean;
  geoipSource: GeoDnsConfigView['geoipSource'];
  maxmindLicenseSecretRef?: string;
  mmdbConfigRef?: string;
  updatedAt: string;
  zones: ZoneState[];
  records: DnsRecordView[];
}

/** A small demo mirror of @swarmy/dns REGION_COORDS for the globe view. */
const DEMO_REGION_COORDS: Record<string, { lat: number; lon: number }> = {
  'us-east': { lat: 39.0, lon: -77.5 }, 'us-west': { lat: 45.6, lon: -121.2 },
  'us-central': { lat: 41.3, lon: -95.9 }, 'ca-central': { lat: 45.5, lon: -73.6 },
  'sa-east': { lat: -23.5, lon: -46.6 }, 'eu-west': { lat: 53.3, lon: -6.3 },
  'eu-central': { lat: 50.1, lon: 8.7 }, 'eu-north': { lat: 59.3, lon: 18.1 },
  'me-south': { lat: 26.1, lon: 50.6 }, 'af-south': { lat: -33.9, lon: 18.4 },
  'ap-south': { lat: 19.1, lon: 72.9 }, 'ap-southeast': { lat: 1.3, lon: 103.8 },
  'ap-northeast': { lat: 35.7, lon: 139.7 }, 'ap-east': { lat: 22.3, lon: 114.2 },
};

function nowIso(): string {
  return new Date().toISOString();
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getState(store: DemoStore): GeoState {
  return store.extra.geo as GeoState;
}

type DemoNode = DemoStore['nodes'][number] & {
  ingress?: boolean;
  outlet?: boolean;
  region?: string | null;
  publicIp?: string | null;
};

/** Eligible geo endpoints: ingress+outlet nodes with a region and a public IP. */
function geoEndpoints(store: DemoStore): Array<{ nodeId: string; region: string; ip: string; healthy: boolean }> {
  return (store.nodes as DemoNode[])
    .filter((n) => n.ingress && n.outlet && n.region && n.publicIp)
    .map((n) => ({
      nodeId: n.id,
      region: n.region!,
      ip: n.publicIp!,
      healthy: n.status === 'online',
    }));
}

function toConfigView(st: GeoState): GeoDnsConfigView {
  return {
    enabled: st.enabled,
    geoipSource: st.geoipSource,
    maxmindLicenseSecretRef: st.maxmindLicenseSecretRef,
    mmdbConfigRef: st.mmdbConfigRef,
    zoneCount: st.zones.length,
    updatedAt: st.updatedAt,
  };
}

function toZoneView(store: DemoStore, z: ZoneState): DnsZoneView {
  const byId = new Map((store.nodes as DemoNode[]).map((n) => [n.id, n]));
  return {
    ...z,
    nameservers: z.advertisedNodeIds.map((nodeId, i) => {
      const n = byId.get(nodeId);
      return {
        label: `ns${i + 1}`,
        fqdn: `ns${i + 1}.${z.zone}`,
        ip: n?.publicIp ?? '',
        nodeId,
        online: n?.status === 'online',
      };
    }),
    conflicts: undefined,
  };
}

// ───────────────────────────────────────────── derived web records ──

/** Ingress domains (host + stack) seeded by the ingress resolver module. */
function ingressDomains(store: DemoStore): Array<{ host: string; stack: string }> {
  const ingress = store.extra.ingress as { domains?: Array<{ host: string; stack: string }> } | undefined;
  return ingress?.domains ?? [];
}

/**
 * Mirror of the controller's zone composition for the dashboard views: hosts
 * under each swarmy-ns zone come from ingress routes plus the zone's apex/www
 * derivation; every host answers with the full eligible endpoint set.
 */
function deriveRows(store: DemoStore, stack?: string): DnsViewRow[] {
  const st = getState(store);
  const endpoints = geoEndpoints(store).map(({ region, ip, healthy }) => ({ region, ip, healthy }));
  const healthyCount = endpoints.filter((e) => e.healthy).length;
  const rows: DnsViewRow[] = [];
  for (const zone of st.zones) {
    if (zone.mode !== 'swarmy-ns') continue;
    const push = (host: string, source: string, stackName?: string): void => {
      if (stack && stackName !== stack) return;
      rows.push({ host, zone: zone.zone, source, stack: stackName, endpoints, healthyCount });
    };
    for (const d of ingressDomains(store)) {
      if (d.host === zone.zone || d.host.endsWith(`.${zone.zone}`)) push(d.host, 'route', d.stack);
    }
    if (zone.apexToEdge) push(zone.zone, 'apex');
    if (zone.autoWww) push(`www.${zone.zone}`, 'www');
  }
  return rows.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

// ───────────────────────────────────────────── resolvers ──

export const geo: DomainResolvers = {
  handlers: {
    // ── org config ──
    'geodns.getConfig': (_i, s): GeoDnsConfigView => toConfigView(getState(s)),

    'geodns.setConfig': (i, s): GeoDnsConfigView => {
      const b = (i as Partial<Pick<GeoState, 'geoipSource' | 'maxmindLicenseSecretRef' | 'mmdbConfigRef'>>) ?? {};
      const st = getState(s);
      if (b.geoipSource !== undefined) st.geoipSource = b.geoipSource;
      if (b.maxmindLicenseSecretRef !== undefined) st.maxmindLicenseSecretRef = b.maxmindLicenseSecretRef;
      if (b.mmdbConfigRef !== undefined) st.mmdbConfigRef = b.mmdbConfigRef;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'geodns.setEnabled': (i, s): GeoDnsConfigView => {
      const { enabled } = i as { enabled: boolean };
      const st = getState(s);
      st.enabled = enabled;
      st.updatedAt = nowIso();
      return toConfigView(st);
    },

    'geodns.applyNow': (_i, s): { summary: string } => {
      const st = getState(s);
      if (!st.enabled) return { summary: 'Geo-DNS is disabled — nothing to apply.' };
      const nodes = geoEndpoints(s).length;
      for (const z of st.zones) z.serial += 1;
      st.updatedAt = nowIso();
      return { summary: `pushed ${st.zones.length} zone(s) to ${nodes} node(s)` };
    },

    // ── zones ──
    'geodns.listZones': (_i, s): DnsZoneView[] =>
      [...getState(s).zones]
        .sort((a, b) => (a.zone < b.zone ? -1 : 1))
        .map((z) => toZoneView(s, z)),

    'geodns.createZone': (i, s): DnsZoneView => {
      const b = i as { zone: string; mode?: string };
      const st = getState(s);
      const z: ZoneState = {
        id: rid('zone'),
        zone: b.zone.toLowerCase().replace(/\.+$/, ''),
        mode: b.mode ?? 'swarmy-ns',
        enabled: true,
        ttl: 30,
        serial: 1,
        apexToEdge: true,
        autoWww: true,
        advertisedNodeIds: [],
        provider: {},
      };
      st.zones = [...st.zones, z];
      st.updatedAt = nowIso();
      return toZoneView(s, z);
    },

    'geodns.updateZone': (i, s): DnsZoneView => {
      const { id, ...patch } = i as { id: string } & Partial<
        Pick<ZoneState, 'enabled' | 'mode' | 'ttl' | 'apexToEdge' | 'autoWww' | 'provider'>
      >;
      const st = getState(s);
      const z = st.zones.find((x) => x.id === id);
      if (!z) throw new Error(`zone not found: ${id}`);
      Object.assign(z, patch);
      z.serial += 1;
      st.updatedAt = nowIso();
      return toZoneView(s, z);
    },

    'geodns.removeZone': (i, s): { id: string } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.zones = st.zones.filter((z) => z.id !== id);
      st.records = st.records.filter((r) => r.zoneId !== id);
      st.updatedAt = nowIso();
      return { id };
    },

    'geodns.setAdvertisedNs': (i, s): DnsZoneView => {
      const { id, nodeIds } = i as { id: string; nodeIds: string[] };
      const st = getState(s);
      const z = st.zones.find((x) => x.id === id);
      if (!z) throw new Error(`zone not found: ${id}`);
      if (nodeIds.length < 2 || nodeIds.length > 4) {
        throw new Error('pin between 2 and 4 nameserver nodes (registrars require ≥2)');
      }
      z.advertisedNodeIds = nodeIds;
      z.serial += 1;
      st.updatedAt = nowIso();
      return toZoneView(s, z);
    },

    'geodns.checkDelegation': (i, s) => {
      const { id } = i as { id: string };
      const st = getState(s);
      const z = st.zones.find((x) => x.id === id);
      if (!z) throw new Error(`zone not found: ${id}`);
      const view = toZoneView(s, z);
      return {
        zone: z.zone,
        publicNs: view.nameservers.map((n) => n.fqdn),
        delegated: view.nameservers.length >= 2,
        nameservers: view.nameservers.map((n) => ({
          fqdn: n.fqdn,
          ip: n.ip,
          reachable: n.online,
          serial: n.online ? z.serial : null,
          serialMatches: n.online,
        })),
      };
    },

    'geodns.previewResolution': (i, s) => {
      const b = i as { id: string; host: string; region?: string };
      const st = getState(s);
      const z = st.zones.find((x) => x.id === b.id);
      if (!z) throw new Error(`zone not found: ${b.id}`);
      const host = b.host.toLowerCase().replace(/\.+$/, '');
      const row = deriveRows(s).find((r) => r.zone === z.zone && r.host === host);
      if (!row) {
        return { host, from: { region: b.region }, answers: [], rcode: 'NXDOMAIN', steered: false, degraded: false };
      }
      const healthy = row.endpoints.filter((e) => e.healthy);
      const degraded = healthy.length === 0 && row.endpoints.length > 0;
      const pool = degraded ? row.endpoints : healthy;
      const local = b.region && st.geoipSource !== 'off' ? pool.filter((e) => e.region === b.region) : [];
      const steered = local.length > 0 && local.length < pool.length;
      const answers = (steered ? local : pool).map((e) => ({ type: 'A', value: e.ip, ttl: z.ttl }));
      return { host, from: { region: b.region }, answers, rcode: 'NOERROR', steered, degraded };
    },

    // ── manual records ──
    'geodns.listRecords': (i, s): DnsRecordView[] => {
      const { zoneId } = i as { zoneId: string };
      return getState(s)
        .records.filter((r) => r.zoneId === zoneId)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.type < b.type ? -1 : 1));
    },

    'geodns.upsertRecord': (i, s): DnsRecordView => {
      const b = i as { zoneId: string; name: string; type: string; value: string; ttl?: number; priority?: number };
      const st = getState(s);
      const name = b.name.trim().toLowerCase() || '@';
      const existing = st.records.find(
        (r) => r.zoneId === b.zoneId && r.name === name && r.type === b.type && r.value === b.value,
      );
      if (existing) {
        existing.ttl = b.ttl ?? null;
        existing.priority = b.priority ?? null;
        st.updatedAt = nowIso();
        return existing;
      }
      const row: DnsRecordView = {
        id: rid('rec'),
        zoneId: b.zoneId,
        name,
        type: b.type,
        value: b.value,
        ttl: b.ttl ?? null,
        priority: b.priority ?? null,
      };
      st.records = [...st.records, row];
      st.updatedAt = nowIso();
      return row;
    },

    'geodns.removeRecord': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.records = st.records.filter((r) => r.id !== id);
      st.updatedAt = nowIso();
      return { id, removed: true };
    },

    // ── views / diagnostics ──
    'geodns.listRegions': (_i, s) => {
      const byRegion = new Map<string, string[]>();
      for (const n of s.nodes as DemoNode[]) {
        const region = n.region ?? n.labels?.['swarmy.region'];
        if (!region) continue;
        const list = byRegion.get(region) ?? [];
        list.push(n.id);
        byRegion.set(region, list);
      }
      const out: Array<{ region: string; lat: number; lng: number; nodeIds: string[]; healthy: boolean; outlets: number }> = [];
      for (const [region, nodeIds] of byRegion) {
        const c = DEMO_REGION_COORDS[region.toLowerCase()];
        if (!c) continue;
        const members = (s.nodes as DemoNode[]).filter((n) => nodeIds.includes(n.id));
        out.push({
          region, lat: c.lat, lng: c.lon, nodeIds,
          healthy: members.some((n) => n.status === 'online'),
          outlets: members.filter((n) => n.outlet).length,
        });
      }
      return out.sort((a, b) => (a.region < b.region ? -1 : 1));
    },

    'geodns.dnsView': (i, s): DnsViewRow[] => {
      const stack = (i as { stack?: string } | undefined)?.stack;
      return deriveRows(s, stack);
    },

    'geodns.checkDomain': (i, s) => {
      const { host } = i as { host: string };
      const row = deriveRows(s).find((r) => r.host === host.toLowerCase().replace(/\.+$/, ''));
      const healthy = row?.endpoints.filter((e) => e.healthy) ?? [];
      const expectedIps = (healthy.length > 0 ? healthy : row?.endpoints ?? []).map((e) => e.ip);
      const gotIp = expectedIps[0] ?? '';
      return {
        resolves: gotIp !== '',
        expectedIps,
        gotIp,
        served: gotIp !== '',
        reachable: healthy.length > 0,
      };
    },

    'geodns.setNodeRegion': (i, s): { id: string; region: string } => {
      const { nodeId, region } = i as { nodeId: string; region: string };
      const node = (s.nodes as DemoNode[]).find((n) => n.id === nodeId);
      if (node) {
        node.region = region;
        node.labels = { ...(node.labels ?? {}), 'swarmy.region': region };
      }
      getState(s).updatedAt = nowIso();
      return { id: nodeId, region };
    },
  },

  seed: (store) => {
    // A coherent slice of the demo cluster: `northwind.dev` fully delegated to
    // swarmy (three pinned nameservers across three regions), the ingress
    // domains from the ingress module deriving their web records, plus a
    // provider-mode zone for contrast. One edge node is draining so a region
    // shows unhealthy in the derived table.
    const edge: Record<string, { region: string; ip: string }> = {
      'n-mgr-1': { region: 'us-east', ip: '203.0.113.10' },
      'n-mgr-2': { region: 'eu-west', ip: '198.51.100.10' },
      'n-wkr-2': { region: 'ap-south', ip: '192.0.2.10' },
      'n-wkr-3': { region: 'us-west', ip: '203.0.113.40' },
    };
    for (const node of store.nodes as DemoNode[]) {
      const e = edge[node.id];
      const region = e?.region ?? 'us-east';
      node.region = region;
      node.labels = { ...(node.labels ?? {}), 'swarmy.region': region };
      if (e) {
        node.ingress = true;
        node.outlet = true;
        node.publicIp = e.ip;
        node.labels['swarmy.node.ingress'] = 'true';
        node.labels['swarmy.node.outlet'] = 'true';
        node.labels['swarmy.node.public-ip'] = e.ip;
      }
    }

    const state: GeoState = {
      enabled: true,
      geoipSource: 'dbip',
      updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      zones: [
        {
          id: 'zone-northwind',
          zone: 'northwind.dev',
          mode: 'swarmy-ns',
          enabled: true,
          ttl: 30,
          serial: 42,
          apexToEdge: true,
          autoWww: true,
          advertisedNodeIds: ['n-mgr-1', 'n-mgr-2', 'n-wkr-2'],
          provider: {},
        },
        {
          id: 'zone-legacy',
          zone: 'northwind.io',
          mode: 'cloudflare',
          enabled: false,
          ttl: 60,
          serial: 7,
          apexToEdge: false,
          autoWww: false,
          advertisedNodeIds: [],
          provider: { zoneId: 'cf-1a2b3c', tokenEnv: 'CLOUDFLARE_API_TOKEN' },
        },
      ],
      records: [
        { id: 'rec-mx1', zoneId: 'zone-northwind', name: '@', type: 'MX', value: 'in1-smtp.messagingengine.com', ttl: 3600, priority: 10 },
        { id: 'rec-mx2', zoneId: 'zone-northwind', name: '@', type: 'MX', value: 'in2-smtp.messagingengine.com', ttl: 3600, priority: 20 },
        { id: 'rec-spf', zoneId: 'zone-northwind', name: '@', type: 'TXT', value: 'v=spf1 include:spf.messagingengine.com ~all', ttl: 3600, priority: null },
        { id: 'rec-dkim', zoneId: 'zone-northwind', name: 'fm1._domainkey', type: 'CNAME', value: 'fm1.northwind.dev.dkim.fmhosted.com', ttl: null, priority: null },
      ],
    };
    store.extra.geo = state;
  },
};
