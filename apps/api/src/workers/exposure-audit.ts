import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, systemContext } from '@swarmy/trpc';
import { buildInventory } from '@swarmy/core';
import { hub, store } from '../gateway';

/**
 * Exposure audit worker (slice E3).
 *
 * Every 5 minutes, per org: classify the live estate (published ports, ingress
 * domains, managed-data labels), diff the public surface against the previous
 * tick, and:
 *   1. NEW public surface (a service newly public, or a new port/domain on an
 *      already-public one) → `exposure-new-surface` warning alert event.
 *   2. Block-rule violations on EXISTING services (public ports on managed
 *      data, public UDP) → `exposure-violation` critical alert events; cleared
 *      violations are resolved.
 *
 * v1 never auto-remediates — swarmy raises the alarm, a human removes the port
 * (the Exposure page says so). The first tick per org is a silent baseline so a
 * controller restart never floods "new surface" alerts.
 *
 * The classifier/rule helpers mirror the unit-tested canonical copies in
 * `@swarmy/trpc` exposure.service.ts — a worker cannot subpath-import an
 * internal trpc module (same constraint queue-reconcile documents).
 */

const TICK_MS = 5 * 60_000;

const INGRESS_ROUTES_LABEL = 'swarmy.ingress.routes';
const MANAGED_PREFIXES: ReadonlyArray<[string, string]> = [
  ['db', 'swarmy.db.'],
  ['cache', 'swarmy.cache.'],
  ['search', 'swarmy.search.'],
  ['vector', 'swarmy.vector.'],
];

// ── Mirrors of the unit-tested pure helpers in exposure.service.ts ────────────

function managedKindOf(labels: Record<string, string>): string | null {
  for (const [kind, prefix] of MANAGED_PREFIXES) {
    for (const key of Object.keys(labels)) if (key.startsWith(prefix)) return kind;
  }
  return null;
}

function routeHosts(labels: Record<string, string>): string[] {
  const raw = labels[INGRESS_ROUTES_LABEL];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => (typeof r === 'object' && r !== null ? (r as { host?: unknown }).host : undefined))
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
  } catch {
    return [];
  }
}

interface RulesFlags {
  noPublicPortsOnManagedData: boolean;
  noPublicUdp: boolean;
  warnOnNewPublishedPorts: boolean;
}

function parseRules(rulesJson: unknown): RulesFlags {
  const o = (typeof rulesJson === 'object' && rulesJson !== null ? rulesJson : {}) as Record<
    string,
    unknown
  >;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  return {
    noPublicPortsOnManagedData: bool(o.noPublicPortsOnManagedData, true),
    noPublicUdp: bool(o.noPublicUdp, true),
    warnOnNewPublishedPorts: bool(o.warnOnNewPublishedPorts, true),
  };
}

// ── Per-org tick state (in-memory; baseline tick after restart is silent) ─────

/** orgId → serviceName → its public-surface keys (`port:<p>/<proto>` | `domain:<host>`). */
const prevSurfaces = new Map<string, Map<string, Set<string>>>();
/** orgId → alert resources (`<signal-scoped>`) that were firing last tick. */
const prevViolations = new Map<string, Set<string>>();

interface AuditedService {
  name: string;
  stack: string;
  resource: string;
  managedKind: string | null;
  surfaces: Set<string>;
  publishedPorts: Array<{ published: number; protocol: string }>;
}

function auditOrg(orgId: string): AuditedService[] {
  const { services, containers } = hub.liveInventory(orgId);
  return buildInventory(services, containers).services.map((s) => {
    const publishedPorts = s.ports
      .filter((p) => typeof p.published === 'number' && p.published > 0)
      .map((p) => ({ published: p.published as number, protocol: p.protocol === 'udp' ? 'udp' : 'tcp' }));
    const surfaces = new Set<string>([
      ...publishedPorts.map((p) => `port:${p.published}/${p.protocol}`),
      ...routeHosts(s.labels).map((h) => `domain:${h}`),
    ]);
    return {
      name: s.name,
      stack: s.stack,
      resource: `${s.stack}/${s.name}`,
      managedKind: managedKindOf(s.labels),
      surfaces,
      publishedPorts,
    };
  });
}

async function tickOrg(orgId: string): Promise<void> {
  // Only audit when the org's swarm is actually reporting — an offline manager
  // would make the whole estate look removed, then "new" again on reconnect.
  if (!hub.managerNode(orgId)) return;
  const audited = auditOrg(orgId);
  if (audited.length === 0) return;

  const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
  const cfg = await prisma.exposureConfig.findUnique({
    where: { orgId },
    select: { rulesJson: true },
  });
  const rules = parseRules(cfg?.rulesJson ?? {});

  // (1) New public surface vs the previous tick (skipped on the baseline tick).
  const prev = prevSurfaces.get(orgId);
  if (prev && rules.warnOnNewPublishedPorts) {
    for (const svc of audited) {
      const before = prev.get(svc.name) ?? new Set<string>();
      const fresh = [...svc.surfaces].filter((k) => !before.has(k));
      if (fresh.length === 0) continue;
      const pretty = fresh
        .map((k) => (k.startsWith('port:') ? `published port ${k.slice(5)}` : k.slice(7)))
        .join(', ');
      await fireEvent(ctx, {
        signal: 'exposure-new-surface',
        severity: 'warning',
        resource: svc.resource,
        message: `New public surface on ${svc.name}: ${pretty}. Expected? If not, remove it — swarmy never removes ports itself.`,
      }).catch(() => undefined);
    }
  }
  prevSurfaces.set(orgId, new Map(audited.map((s) => [s.name, s.surfaces])));

  // (2) Block-rule violations on the EXISTING estate → critical alert events.
  //     (No auto-remediation in v1 — alert only.)
  const firing = new Set<string>();
  for (const svc of audited) {
    if (svc.publishedPorts.length === 0) continue;
    if (rules.noPublicPortsOnManagedData && svc.managedKind) {
      const ports = svc.publishedPorts.map((p) => p.published).join(', ');
      firing.add(svc.resource);
      await fireEvent(ctx, {
        signal: 'exposure-violation',
        severity: 'critical',
        resource: svc.resource,
        message: `Managed ${svc.managedKind} service ${svc.name} publishes port${svc.publishedPorts.length === 1 ? '' : 's'} ${ports} publicly — remove the published port and use private networking.`,
      }).catch(() => undefined);
      continue; // one violation event per service is enough
    }
    const udp = svc.publishedPorts.filter((p) => p.protocol === 'udp');
    if (rules.noPublicUdp && udp.length > 0) {
      firing.add(svc.resource);
      await fireEvent(ctx, {
        signal: 'exposure-violation',
        severity: 'critical',
        resource: svc.resource,
        message: `${svc.name} publishes UDP port${udp.length === 1 ? '' : 's'} ${udp.map((p) => p.published).join(', ')} publicly — remove it or approve it with a deploy override.`,
      }).catch(() => undefined);
    }
  }

  // Resolve violations that cleared since the last tick.
  const before = prevViolations.get(orgId) ?? new Set<string>();
  for (const resource of before) {
    if (firing.has(resource)) continue;
    await fireEvent(ctx, {
      signal: 'exposure-violation',
      severity: 'info',
      resource,
      message: `${resource} no longer violates the exposure rules`,
      status: 'resolved',
    }).catch(() => undefined);
  }
  prevViolations.set(orgId, firing);
}

export function startExposureAudit(): () => void {
  const timer = setInterval(() => {
    const orgIds = new Set(store.nodeOrg.values());
    for (const orgId of orgIds) void tickOrg(orgId).catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
