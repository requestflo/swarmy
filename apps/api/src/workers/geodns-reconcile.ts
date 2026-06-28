/**
 * Health-aware Geo-DNS reconcile worker (epic #12, Part A — PHASE 2).
 *
 * Polls live region health (node online via heartbeat) per org, flips each
 * `DnsRecord.healthy` to match, and — only when the healthy *answer set* changes
 * and Geo-DNS is enabled — re-renders the (health-filtered) CoreDNS zone and
 * redeploys it via the existing `service.deploy` dispatch. Failover = dropping
 * unhealthy regions from the answer set, so DNS biases new clients to healthy
 * regions.
 *
 * The selection/diff/render logic lives in pure, unit-tested modules in
 * @swarmy/trpc (`geodns-reconcile.core.ts`, `geo-steer.ts`, the renderer in
 * `geodns.service.ts`). A small copy is inlined here because the worker cannot
 * subpath-import an internal trpc module — same constraint as dr-reconcile.
 */
import { prisma } from '@swarmy/db';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { hub } from '../gateway';

const TICK_MS = 30_000;
const COREDNS_IMAGE = 'coredns/coredns:1.11.3';
const DEFAULT_TTL = 30;

// ── pure core (mirror of @swarmy/trpc geodns-reconcile.core.ts) ──────────────

interface ReconcileRecord {
  id: string;
  host: string;
  region: string;
  targetIngress: string;
  healthy: boolean;
}
interface RegionHealth {
  region: string;
  nodeOnline: boolean;
  ingressHealthy?: boolean;
}

function computeRecordHealth(record: ReconcileRecord, health: Map<string, RegionHealth>): boolean {
  const h = health.get(record.region);
  if (!h) return false;
  if (!h.nodeOnline) return false;
  if (h.ingressHealthy === false) return false;
  return true;
}

function planReconcile(
  records: ReconcileRecord[],
  health: Map<string, RegionHealth>,
): { updates: Array<{ id: string; healthy: boolean }>; healthySetChanged: boolean } {
  const updates: Array<{ id: string; healthy: boolean }> = [];
  let healthySetChanged = false;
  for (const r of records) {
    const next = computeRecordHealth(r, health);
    if (next !== r.healthy) {
      updates.push({ id: r.id, healthy: next });
      healthySetChanged = true;
    }
  }
  return { updates, healthySetChanged };
}

// ── pure zone renderer (mirror of @swarmy/trpc renderCoreDns) ────────────────

const isIp = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

function renderZone(
  zone: string,
  ttl: number,
  serial: number,
  records: ReconcileRecord[],
): string {
  const byHost = new Map<string, ReconcileRecord[]>();
  for (const r of records) {
    const list = byHost.get(r.host) ?? [];
    list.push(r);
    byHost.set(r.host, list);
  }
  const lines = [
    `$ORIGIN ${zone}.`,
    `$TTL ${ttl}`,
    `@\tIN\tSOA\tns.${zone}. admin.${zone}. ( ${serial} 7200 3600 1209600 ${ttl} )`,
    `@\tIN\tNS\tns.${zone}.`,
  ];
  for (const [host, eps] of [...byHost.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let pool = eps.filter((e) => e.healthy);
    if (pool.length === 0) pool = eps; // spill: never NXDOMAIN
    const label = host.endsWith(zone) ? host.slice(0, -(zone.length + 1)) || '@' : host;
    for (const e of pool) {
      const rtype = isIp(e.targetIngress) ? 'A' : 'CNAME';
      lines.push(`${label}\tIN\t${rtype}\t${e.targetIngress}`);
    }
  }
  return lines.join('\n') + '\n';
}

function coreDnsSpec(zone: string, ttl: number, serial: number, records: ReconcileRecord[]): ServiceSpec {
  const zonefile = renderZone(zone, ttl, serial, records);
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
  return {
    name: 'swarmy-coredns',
    image: COREDNS_IMAGE,
    mode: { replicated: { replicas: Math.max(1, Math.min(3, records.length || 1)) } },
    args: ['-conf', '/etc/coredns/Corefile'],
    labels: {
      'swarmy.gslb': 'coredns',
      'swarmy.gslb.serial': String(serial),
      // The rendered files live in service labels for visibility/audit (MVP).
      'swarmy.gslb.corefile': corefile,
      'swarmy.gslb.zonefile': zonefile,
    },
    ports: [
      { target: 53, published: 53, protocol: 'udp', mode: 'host' },
      { target: 53, published: 53, protocol: 'tcp', mode: 'host' },
    ],
    placement: { preferences: ['spread=node.labels.swarmy.region'], maxReplicasPerNode: 1 },
  };
}

// ── IO shell ─────────────────────────────────────────────────────────────────

interface GeoDb {
  geoDnsConfig: {
    findUnique(a: unknown): Promise<{ enabled: boolean; zone: string; ttl: number } | null>;
  };
  dnsRecord: {
    findMany(a: unknown): Promise<ReconcileRecord[]>;
    update(a: unknown): Promise<unknown>;
  };
}

/** A connected swarm manager to redeploy the CoreDNS zone through (Docker truth). */
function resolveManagerNodeId(orgId: string): string | null {
  return hub.managerNodes(orgId)[0] ?? null;
}

/** Region health from the live swarm node inventory (labels + status are Docker
 *  truth). `swarmy.region` node labels group nodes into regions; a region is
 *  healthy if at least one of its nodes is `ready`. Offline nodes fold in via
 *  `includeOffline` (status `down`) so a region with only dead nodes flips. */
function collectRegionHealth(orgId: string): Map<string, RegionHealth> {
  const health = new Map<string, RegionHealth>();
  for (const n of hub.nodeInventory(orgId, true)) {
    const region = n.labels['swarmy.region'];
    if (!region) continue;
    const online = n.status === 'ready';
    const existing = health.get(region);
    if (existing) existing.nodeOnline = existing.nodeOnline || online;
    else health.set(region, { region, nodeOnline: online });
  }
  return health;
}

async function reconcileOrg(orgId: string): Promise<void> {
  const db = prisma as unknown as GeoDb;
  const cfg = await db.geoDnsConfig.findUnique({ where: { orgId } });
  const records = await db.dnsRecord.findMany({ where: { orgId } });
  if (records.length === 0) return;

  const health = collectRegionHealth(orgId);
  const plan = planReconcile(records, health);

  for (const u of plan.updates) {
    await db.dnsRecord.update({ where: { id: u.id }, data: { healthy: u.healthy } }).catch(() => undefined);
  }

  if (!plan.healthySetChanged || !cfg?.enabled) return;

  const nodeId = resolveManagerNodeId(orgId);
  if (!nodeId) return;

  // Re-read with flipped health so the redeployed zone reflects the new set.
  const next = records.map((r) => {
    const u = plan.updates.find((x) => x.id === r.id);
    return u ? { ...r, healthy: u.healthy } : r;
  });
  const serial = Math.floor(Date.now() / 1000);
  const spec = coreDnsSpec(cfg.zone || 'example.com', cfg.ttl || DEFAULT_TTL, serial, next);
  await hub.dispatch(nodeId, 'service.deploy', { spec, pullPolicy: 'always' }).catch(() => undefined);
}

async function tick(): Promise<void> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    await reconcileOrg(org.id).catch(() => undefined);
  }
}

export function startGeoDnsReconcile(): () => void {
  const timer = setInterval(() => {
    tick().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
