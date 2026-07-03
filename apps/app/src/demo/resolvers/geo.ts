import type { DemoStore, DomainResolvers } from '../types';

/**
 * Geo-DNS + HA-templates demo resolvers — the Geo surface (apps/app `/geo`).
 *
 * Covers two routers:
 *  - `geodns.*` — the CoreDNS GSLB config, DNS records, node-region labels, and a
 *    pure rendered-zone preview / "apply now".
 *  - `templates.*` — the ready-made HA template gallery + pure compose preview +
 *    deploy (which can wire Geo-DNS records, mirroring the real deploy flow).
 *
 * State lives in `store.extra.geo` (config + records + region labels). Mutations
 * flip booleans / push rows so the page reflects changes after it invalidates and
 * re-reads. Return shapes mirror the controller views exactly (GeoDnsConfigView,
 * DnsRecordView, the zone preview, TemplateMeta, RenderedTemplate,
 * DeployTemplateResult) so the dashboard renders without surprises.
 */

// ───────────────────────────────────────────── controller view mirrors ──

/** Mirror of `GeoDnsConfigView` (geodns.service.ts). */
interface GeoDnsConfigView {
  enabled: boolean;
  zone: string;
  ttl: number;
  provider: string;
  recordCount: number;
  updatedAt: string;
}

/** Mirror of `DnsRecordView` (geodns.service.ts). */
interface DnsRecordView {
  id: string;
  host: string;
  region: string;
  targetIngress: string;
  healthy: boolean;
}

/** Mirror of the `previewZone` / `renderCoreDns` return (geodns.service.ts). */
interface ZonePreview {
  summary: string;
  files: { path: string; contents: string }[];
}

/** Mirror of `TemplateMeta` (templates.ts). */
interface TemplateMeta {
  id: TemplateId;
  kind: 'database' | 'cache';
  engine: 'postgres' | 'redis';
  title: string;
  blurb: string;
  recommendedRegions: number;
}

/** Mirror of `RenderedTemplate` (templates.ts). */
interface RenderedTemplate {
  services: ServiceSpecLite[];
  composeSource: string;
  connectionHint: string;
  durabilityNote: string;
}

/** Mirror of `DeployTemplateResult` (templates.ts). */
interface DeployTemplateResult {
  stackId: string;
  deploymentId: string;
  connectionHint: string;
  durabilityNote: string;
  geoRecords: number;
}

/**
 * A trimmed `ServiceSpec` — enough of the protocol shape that `templates.preview`
 * returns believable specs. The gallery only reads `composeSource`,
 * `connectionHint` and `durabilityNote`, but we fill `services` too so the value
 * matches what `renderTemplate` produces.
 */
interface ServiceSpecLite {
  name: string;
  image: string;
  mode: { replicated: { replicas: number } };
  env?: Record<string, string>;
  networks?: string[];
  placement?: { constraints?: string[]; preferences?: string[]; maxReplicasPerNode?: number };
}

type TemplateId = 'postgres-ha' | 'redis-ha';

// ───────────────────────────────────────────── demo world ──

/** The mutable demo world behind the Geo page. */
interface GeoState {
  enabled: boolean;
  zone: string;
  ttl: number;
  provider: string;
  updatedAt: string;
  records: DnsRecordView[];
  /** nodeId → region label (the `swarmy.region` value we'd push to the engine). */
  nodeRegions: Record<string, string>;
}

const DEFAULT_TTL = 30;

function nowIso(): string {
  return new Date().toISOString();
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getState(store: DemoStore): GeoState {
  return store.extra.geo as GeoState;
}

/** Mirrors the controller's `stackDnsScope`: a record belongs to a stack when
 *  its host is one of that stack's ingress hosts (read off `store.extra.ingress`). */
function stackDnsHosts(store: DemoStore, stack: string): Set<string> {
  const ingress = store.extra.ingress as { domains?: { host: string; stack: string }[] } | undefined;
  return new Set((ingress?.domains ?? []).filter((d) => d.stack === stack).map((d) => d.host));
}

function toConfigView(st: GeoState): GeoDnsConfigView {
  return {
    enabled: st.enabled,
    zone: st.zone,
    ttl: st.ttl,
    provider: st.provider,
    recordCount: st.records.length,
    updatedAt: st.updatedAt,
  };
}

// ───────────────────────────────────────────── CoreDNS render (pure) ──
// A self-contained mirror of `renderCoreDns` (geodns.service.ts): failover by
// omission (only healthy records answer; if a host has no healthy region we spill
// to all so we never NXDOMAIN), with a region tag comment so the steering is
// auditable. Deterministic enough for a believable preview.

const isIp = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** A small demo mirror of geo-steer's REGION_COORDS for the globe view. */
const DEMO_REGION_COORDS: Record<string, { lat: number; lon: number }> = {
  'us-east': { lat: 39.0, lon: -77.5 }, 'us-west': { lat: 45.6, lon: -121.2 },
  'us-central': { lat: 41.3, lon: -95.9 }, 'ca-central': { lat: 45.5, lon: -73.6 },
  'sa-east': { lat: -23.5, lon: -46.6 }, 'eu-west': { lat: 53.3, lon: -6.3 },
  'eu-central': { lat: 50.1, lon: 8.7 }, 'eu-north': { lat: 59.3, lon: 18.1 },
  'me-south': { lat: 26.1, lon: 50.6 }, 'af-south': { lat: -33.9, lon: 18.4 },
  'ap-south': { lat: 19.1, lon: 72.9 }, 'ap-southeast': { lat: 1.3, lon: 103.8 },
  'ap-northeast': { lat: 35.7, lon: 139.7 }, 'ap-east': { lat: 22.3, lon: 114.2 },
};

interface RenderedHost {
  host: string;
  selected: DnsRecordView[];
  degraded: boolean;
}

function planHosts(records: DnsRecordView[]): RenderedHost[] {
  const byHost = new Map<string, DnsRecordView[]>();
  for (const r of records) {
    const list = byHost.get(r.host) ?? [];
    list.push(r);
    byHost.set(r.host, list);
  }
  const plan: RenderedHost[] = [];
  for (const [host, eps] of [...byHost.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const healthy = eps.filter((e) => e.healthy);
    const degraded = healthy.length === 0 && eps.length > 0;
    const pool = degraded ? eps : healthy;
    const selected = [...pool].sort((a, b) => {
      if (a.region !== b.region) return a.region < b.region ? -1 : 1;
      return a.targetIngress < b.targetIngress ? -1 : a.targetIngress > b.targetIngress ? 1 : 0;
    });
    plan.push({ host, selected, degraded });
  }
  return plan;
}

function renderZone(st: GeoState, serial = 0): ZonePreview {
  const zone = st.zone || 'example.com';
  const ttl = st.ttl || DEFAULT_TTL;
  const plan = planHosts(st.records);

  const lines: string[] = [
    `$ORIGIN ${zone}.`,
    `$TTL ${ttl}`,
    `@\tIN\tSOA\tns.${zone}. admin.${zone}. ( ${serial} 7200 3600 1209600 ${ttl} )`,
    `@\tIN\tNS\tns.${zone}.`,
  ];

  let degradedHosts = 0;
  let recordCount = 0;
  for (const { host, selected, degraded } of plan) {
    if (degraded) degradedHosts++;
    const label = host.endsWith(zone) ? host.slice(0, -(zone.length + 1)) || '@' : host;
    for (const e of selected) {
      const rtype = isIp(e.targetIngress) ? 'A' : 'CNAME';
      lines.push(
        `${label}\tIN\t${rtype}\t${e.targetIngress}\t; region=${e.region}${degraded ? ' DEGRADED' : ''}`,
      );
      recordCount++;
    }
  }

  const zonefile = lines.join('\n') + '\n';
  const corefile = [
    `${zone}:53 {`,
    `    file /etc/coredns/${zone}.zone`,
    '    geoip /etc/coredns/GeoLite2-City.mmdb {',
    '        edns-subnet',
    '    }',
    '    metadata',
    '    loadbalance',
    '    health',
    '    ready',
    `    cache ${ttl}`,
    '    log',
    '    errors',
    '}',
    '',
  ].join('\n');

  const summary = `CoreDNS zone ${zone} · TTL ${ttl}s · ${plan.length} host(s) · ${recordCount} healthy record(s)${
    degradedHosts ? ` · ${degradedHosts} host(s) DEGRADED (all-unhealthy spill)` : ''
  }`;

  return {
    summary,
    files: [
      { path: '/etc/coredns/Corefile', contents: corefile },
      { path: `/etc/coredns/${zone}.zone`, contents: zonefile },
    ],
  };
}

// ───────────────────────────────────────────── HA templates (pure) ──
// A self-contained mirror of the two built-in templates (templates.ts): the
// gallery renders `composeSource` verbatim plus the connection/durability hints.

const TEMPLATE_METAS: Record<TemplateId, TemplateMeta> = {
  'postgres-ha': {
    id: 'postgres-ha',
    kind: 'database',
    engine: 'postgres',
    title: 'Postgres — High Availability',
    blurb: 'Primary + streaming replica, one per region. Survives a region going dark.',
    recommendedRegions: 3,
  },
  'redis-ha': {
    id: 'redis-ha',
    kind: 'cache',
    engine: 'redis',
    title: 'Redis — High Availability',
    blurb: 'Primary + replicas + sentinels spread across regions for automatic failover.',
    recommendedRegions: 3,
  },
};

const POSTGRES_IMAGE = 'bitnami/postgresql-repmgr:16';
const REDIS_IMAGE = 'bitnami/redis-sentinel:7';
const REDIS_DATA_IMAGE = 'bitnami/redis:7';

function envBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `        - ${k}=${v}`)
    .join('\n');
}

function composeService(opts: {
  name: string;
  image: string;
  env?: Record<string, string>;
  replicas?: number;
  constraints?: string[];
  preferences?: string[];
  maxReplicasPerNode?: number;
}): string {
  const lines: string[] = [`  ${opts.name}:`, `    image: ${opts.image}`];
  if (opts.env && Object.keys(opts.env).length) {
    lines.push('    environment:');
    lines.push(envBlock(opts.env));
  }
  lines.push('    deploy:');
  if (opts.replicas !== undefined) lines.push(`      replicas: ${opts.replicas}`);
  lines.push('      placement:');
  if (opts.constraints?.length) {
    lines.push('        constraints:');
    for (const c of opts.constraints) lines.push(`          - ${c}`);
  }
  if (opts.preferences?.length) {
    lines.push('        preferences:');
    for (const p of opts.preferences) lines.push(`          - spread: ${p}`);
  }
  if (opts.maxReplicasPerNode !== undefined) {
    lines.push(`      max_replicas_per_node: ${opts.maxReplicasPerNode}`);
  }
  return lines.join('\n');
}

interface TemplateParams {
  name: string;
  regions: string[];
  image?: string;
  replicasPerRegion?: number;
}

function renderPostgresHa(p: TemplateParams): RenderedTemplate {
  const image = p.image ?? POSTGRES_IMAGE;
  const regions = p.regions.length ? p.regions : ['default'];
  const dbName = p.name.replace(/[^a-z0-9_]/gi, '_');
  const baseEnv: Record<string, string> = {
    POSTGRESQL_PASSWORD: '${POSTGRES_PASSWORD:-changeme}',
    REPMGR_PASSWORD: '${REPMGR_PASSWORD:-changeme}',
    POSTGRESQL_DATABASE: dbName,
    REPMGR_PRIMARY_HOST: `${p.name}-pg-0`,
  };

  const services: ServiceSpecLite[] = regions.map((region, i) => ({
    name: `${p.name}-pg-${i}`,
    image,
    mode: { replicated: { replicas: 1 } },
    env: {
      ...baseEnv,
      REPMGR_NODE_NAME: `${p.name}-pg-${i}`,
      REPMGR_PARTNER_NODES: regions.map((_, j) => `${p.name}-pg-${j}`).join(','),
    },
    networks: [`${p.name}-net`],
    placement: { constraints: [`node.labels.swarmy.region==${region}`] },
  }));

  const composeServices = regions
    .map((region, i) =>
      composeService({
        name: `${p.name}-pg-${i}`,
        image,
        env: { ...baseEnv, REPMGR_NODE_NAME: `${p.name}-pg-${i}` },
        replicas: 1,
        constraints: [`node.labels.swarmy.region==${region}`],
      }),
    )
    .join('\n');

  const composeSource = [
    'version: "3.8"',
    'services:',
    composeServices,
    'volumes:',
    ...regions.map((_, i) => `  ${p.name}-pg-${i}-data:`),
    'networks:',
    `  ${p.name}-net:`,
    '    driver: overlay',
  ].join('\n');

  return {
    services,
    composeSource,
    connectionHint: `postgres://postgres@${p.name}-pg-0:5432/${dbName}`,
    durabilityNote:
      regions.length >= 3
        ? `Survives loss of 1 region (${regions.length} regions). Streaming replication is synchronous-capable; cross-region commit adds latency.`
        : `Only ${regions.length} region(s): no quorum tiebreaker, so automatic failover is unsafe. Add a 3rd region (or a witness) for clean failover.`,
  };
}

function renderRedisHa(p: TemplateParams): RenderedTemplate {
  const dataImage = p.image ?? REDIS_DATA_IMAGE;
  const regions = p.regions.length ? p.regions : ['default'];
  const replicasPerRegion = p.replicasPerRegion ?? 1;
  const replicaCount = Math.max(1, (regions.length - 1) * replicasPerRegion);

  const masterEnv: Record<string, string> = {
    REDIS_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_REPLICATION_MODE: 'master',
  };
  const replicaEnv: Record<string, string> = {
    REDIS_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_MASTER_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_REPLICATION_MODE: 'replica',
    REDIS_MASTER_HOST: `${p.name}-redis-master`,
  };
  const sentinelEnv: Record<string, string> = {
    REDIS_MASTER_HOST: `${p.name}-redis-master`,
    REDIS_MASTER_PASSWORD: '${REDIS_PASSWORD:-changeme}',
    REDIS_SENTINEL_QUORUM: String(Math.floor(regions.length / 2) + 1),
  };

  const services: ServiceSpecLite[] = [
    {
      name: `${p.name}-redis-master`,
      image: dataImage,
      mode: { replicated: { replicas: 1 } },
      env: masterEnv,
      networks: [`${p.name}-net`],
      placement: { constraints: [`node.labels.swarmy.region==${regions[0]}`] },
    },
    {
      name: `${p.name}-redis-replica`,
      image: dataImage,
      mode: { replicated: { replicas: replicaCount } },
      env: replicaEnv,
      networks: [`${p.name}-net`],
      placement: { preferences: ['spread=node.labels.swarmy.region'], maxReplicasPerNode: 1 },
    },
    ...regions.map((region, i) => ({
      name: `${p.name}-redis-sentinel-${i}`,
      image: REDIS_IMAGE,
      mode: { replicated: { replicas: 1 } },
      env: sentinelEnv,
      networks: [`${p.name}-net`],
      placement: { constraints: [`node.labels.swarmy.region==${region}`] },
    })),
  ];

  const composeSource = [
    'version: "3.8"',
    'services:',
    composeService({
      name: `${p.name}-redis-master`,
      image: dataImage,
      env: masterEnv,
      replicas: 1,
      constraints: [`node.labels.swarmy.region==${regions[0]}`],
    }),
    composeService({
      name: `${p.name}-redis-replica`,
      image: dataImage,
      env: replicaEnv,
      replicas: replicaCount,
      preferences: ['node.labels.swarmy.region'],
      maxReplicasPerNode: 1,
    }),
    ...regions.map((region, i) =>
      composeService({
        name: `${p.name}-redis-sentinel-${i}`,
        image: REDIS_IMAGE,
        env: sentinelEnv,
        replicas: 1,
        constraints: [`node.labels.swarmy.region==${region}`],
      }),
    ),
    'networks:',
    `  ${p.name}-net:`,
    '    driver: overlay',
  ].join('\n');

  return {
    services,
    composeSource,
    connectionHint: `Use a sentinel-aware client → ${regions
      .map((_, i) => `${p.name}-redis-sentinel-${i}:26379`)
      .join(', ')} (master: ${p.name}-redis-master)`,
    durabilityNote:
      regions.length >= 3
        ? `Survives loss of 1 region (${regions.length} sentinels). Redis replication is async — a small write-loss window is possible on failover (non-zero RPO).`
        : `Only ${regions.length} region(s): sentinel quorum needs >=3 for safe automatic failover. Add a 3rd region or a witness sentinel.`,
  };
}

function renderTemplate(id: TemplateId, params: TemplateParams): RenderedTemplate | null {
  if (id === 'postgres-ha') return renderPostgresHa(params);
  if (id === 'redis-ha') return renderRedisHa(params);
  return null;
}

// ───────────────────────────────────────────── resolvers ──

export const geo: DomainResolvers = {
  handlers: {
    // ── geodns ──
    'geodns.getConfig': (_i, s): GeoDnsConfigView => toConfigView(getState(s)),

    'geodns.setConfig': (i, s): GeoDnsConfigView => {
      const b = (i as { zone?: string; ttl?: number } | undefined) ?? {};
      const st = getState(s);
      if (b.zone !== undefined) st.zone = b.zone;
      if (b.ttl !== undefined) st.ttl = b.ttl;
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

    'geodns.listRecords': (i, s): DnsRecordView[] => {
      const stack = (i as { stack?: string } | undefined)?.stack;
      const hosts = stack ? stackDnsHosts(s, stack) : null;
      return [...getState(s).records]
        .filter((r) => !hosts || hosts.has(r.host))
        .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
    },

    // DNS view + per-domain probe (Edge/geo): mirror geodns.dnsView/checkDomain so
    // the DNS-health page lights up under ?demo=1.
    'geodns.dnsView': (i, s) => {
      const stack = (i as { stack?: string } | undefined)?.stack;
      const hosts = stack ? stackDnsHosts(s, stack) : null;
      return [...getState(s).records]
        .filter((r) => !hosts || hosts.has(r.host))
        .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
        .map((r) => ({
          host: r.host,
          region: r.region,
          target: r.targetIngress,
          ip: isIp(r.targetIngress) ? r.targetIngress : `203.0.113.${(r.host.length % 50) + 1}`,
          healthy: r.healthy,
        }));
    },

    'geodns.checkDomain': (i, s) => {
      const { host } = i as { host: string };
      const eps = getState(s).records.filter((r) => r.host === host);
      const preferred = eps.find((e) => e.healthy) ?? eps[0];
      const expectedIp = preferred
        ? isIp(preferred.targetIngress)
          ? preferred.targetIngress
          : `203.0.113.${(host.length % 50) + 1}`
        : '';
      const resolves = !!preferred;
      return { resolves, expectedIp, gotIp: resolves ? expectedIp : '', reachable: resolves && !!preferred?.healthy };
    },

    // Region globe: regions with coords + node assignments + health.
    'geodns.listRegions': (_i, s) => {
      const byRegion = new Map<string, string[]>();
      for (const n of s.nodes) {
        const region = (n as { region?: string }).region ?? (n as { labels?: Record<string, string> }).labels?.['swarmy.region'];
        if (!region) continue;
        const list = byRegion.get(region) ?? [];
        list.push(n.id);
        byRegion.set(region, list);
      }
      const out: { region: string; lat: number; lng: number; nodeIds: string[]; healthy: boolean; outlets: number }[] = [];
      for (const [region, nodeIds] of byRegion) {
        const c = DEMO_REGION_COORDS[region.toLowerCase()];
        if (!c) continue;
        const members = s.nodes.filter((n) => nodeIds.includes(n.id));
        out.push({
          region, lat: c.lat, lng: c.lon, nodeIds,
          healthy: members.some((n) => n.status === 'online'),
          outlets: members.filter((n) => (n as { outlet?: boolean }).outlet).length,
        });
      }
      return out.sort((a, b) => (a.region < b.region ? -1 : 1));
    },

    'geodns.upsertRecord': (i, s): DnsRecordView => {
      const b = i as { host: string; region: string; targetIngress: string; healthy?: boolean };
      const st = getState(s);
      const existing = st.records.find((r) => r.host === b.host && r.region === b.region);
      if (existing) {
        existing.targetIngress = b.targetIngress;
        existing.healthy = b.healthy ?? true;
        st.updatedAt = nowIso();
        return existing;
      }
      const row: DnsRecordView = {
        id: rid('dns'),
        host: b.host,
        region: b.region,
        targetIngress: b.targetIngress,
        healthy: b.healthy ?? true,
      };
      st.records = [row, ...st.records];
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

    'geodns.setNodeRegion': (i, s): { id: string; region: string } => {
      const { nodeId, region } = i as { nodeId: string; region: string };
      const st = getState(s);
      st.nodeRegions[nodeId] = region;
      // Mirror the real path: stamp the `swarmy.region` label on the node so other
      // surfaces (and the zone health composition) see it.
      const node = s.nodes.find((n) => n.id === nodeId);
      if (node) node.labels = { ...(node.labels ?? {}), 'swarmy.region': region };
      st.updatedAt = nowIso();
      return { id: nodeId, region };
    },

    'geodns.previewZone': (_i, s): ZonePreview => renderZone(getState(s)),

    'geodns.applyNow': (_i, s): { summary: string } => {
      const st = getState(s);
      if (!st.enabled) return { summary: 'Geo-DNS is disabled — nothing to apply.' };
      const serial = Math.floor(Date.now() / 1000);
      st.updatedAt = nowIso();
      return { summary: renderZone(st, serial).summary };
    },

    // ── templates ──
    'templates.list': (): TemplateMeta[] => Object.values(TEMPLATE_METAS),

    'templates.preview': (i): RenderedTemplate => {
      const b = i as { id: TemplateId; params: TemplateParams };
      const rendered = renderTemplate(b.id, b.params);
      if (!rendered) throw new Error(`unknown template: ${b.id}`);
      return rendered;
    },

    'templates.deploy': (i, s): DeployTemplateResult => {
      const b = i as {
        id: TemplateId;
        params: TemplateParams;
        geo?: { host: string; targets?: Record<string, string> };
      };
      const rendered = renderTemplate(b.id, b.params);
      if (!rendered) throw new Error(`unknown template: ${b.id}`);

      // Mirror the real deploy: it runs through the stack pipeline → a new stack
      // row appears on the Applications surface.
      const stackId = rid('stk');
      s.stacks = [
        {
          id: stackId,
          name: b.params.name,
          serviceCount: rendered.services.length,
          status: 'running',
          updatedAt: nowIso(),
        },
        ...s.stacks,
      ];

      // Compose with Geo-DNS Part A: seed one record per region with a target.
      let geoRecords = 0;
      if (b.geo?.host) {
        const st = getState(s);
        const targets = b.geo.targets ?? {};
        for (const region of b.params.regions) {
          const target = targets[region];
          if (!target) continue;
          const existing = st.records.find((r) => r.host === b.geo!.host && r.region === region);
          if (existing) {
            existing.targetIngress = target;
            existing.healthy = true;
          } else {
            st.records = [
              { id: rid('dns'), host: b.geo.host, region, targetIngress: target, healthy: true },
              ...st.records,
            ];
          }
          geoRecords++;
        }
        st.updatedAt = nowIso();
      }

      return {
        stackId,
        deploymentId: rid('dep'),
        connectionHint: rendered.connectionHint,
        durabilityNote: rendered.durabilityNote,
        geoRecords,
      };
    },
  },

  seed: (store) => {
    // A coherent slice of the demo cluster: Geo-DNS live for `geo.northwind.dev`,
    // three hosts steered across regions with one region currently unhealthy (so
    // the rendered preview shows failover by omission), and the demo nodes already
    // carry region labels matching the records.
    const state: GeoState = {
      enabled: true,
      zone: 'geo.northwind.dev',
      ttl: 30,
      provider: 'coredns',
      updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      records: [
        { id: 'dns-app-us', host: 'app.geo.northwind.dev', region: 'us-east', targetIngress: '203.0.113.10', healthy: true },
        { id: 'dns-app-eu', host: 'app.geo.northwind.dev', region: 'eu-west', targetIngress: '198.51.100.10', healthy: true },
        { id: 'dns-app-ap', host: 'app.geo.northwind.dev', region: 'ap-south', targetIngress: '192.0.2.10', healthy: false },
        { id: 'dns-api-us', host: 'api.geo.northwind.dev', region: 'us-east', targetIngress: 'us.ingress.northwind.dev', healthy: true },
        { id: 'dns-api-eu', host: 'api.geo.northwind.dev', region: 'eu-west', targetIngress: 'eu.ingress.northwind.dev', healthy: true },
        { id: 'dns-cdn-us', host: 'cdn.geo.northwind.dev', region: 'us-east', targetIngress: '203.0.113.20', healthy: true },
        // Scoped to the `storefront` stack's own ingress host (shop.northwind.dev)
        // so its Network tab's Geo-DNS section shows real steering, not an empty state.
        { id: 'dns-shop-us', host: 'shop.northwind.dev', region: 'us-east', targetIngress: '203.0.113.30', healthy: true },
        { id: 'dns-shop-eu', host: 'shop.northwind.dev', region: 'eu-west', targetIngress: '198.51.100.30', healthy: true },
      ],
      // Region labels for the demo nodes (n-mgr-1/n-mgr-2/n-wkr-1/n-wkr-2/n-wkr-3).
      nodeRegions: {
        'n-mgr-1': 'us-east',
        'n-mgr-2': 'eu-west',
        'n-wkr-1': 'us-east',
        'n-wkr-2': 'eu-west',
        'n-wkr-3': 'ap-south',
      },
    };
    // Stamp the labels onto the live nodes so the zone's region health and other
    // surfaces stay consistent with the seeded records.
    for (const node of store.nodes) {
      const region = state.nodeRegions[node.id];
      if (region) node.labels = { ...(node.labels ?? {}), 'swarmy.region': region };
    }
    store.extra.geo = state;
  },
};
