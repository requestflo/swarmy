import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { fireEvent, managedKindOf, parseExposureRules, readRoutes, systemContext } from '@swarmy/trpc';
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
 * Managed-data detection and rule parsing are the canonical
 * `exposure.service` helpers; route hosts come from `ingress-routes`.
 */

const TICK_MS = 5 * 60_000;

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
      ...readRoutes(s.labels).map((r) => `domain:${r.host}`),
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
  const rules = parseExposureRules(cfg?.rulesJson ?? {}, false);

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
