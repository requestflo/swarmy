import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';

/**
 * Incident recording helper (slice C4) — appends an event to the open incident
 * for `groupKey` (opening one if needed) so automation (alert-evaluator, A2
 * failover promotion, deploy safety) can build the incident timeline without
 * owning incident lifecycle logic.
 *
 * Group-key storage: the `Incident` model has no groupKey column, so the key is
 * carried inside the FIRST IncidentEvent's `meta` JSON (`meta.groupKey`,
 * stamped on every helper-written event for good measure). Matching loads the
 * org's OPEN incidents with their opening event and matches in code
 * (`matchOpenIncident`, pure + unit-tested). Open incidents per org are a
 * handful at worst, so the scan is cheap and avoids fragile title conventions.
 * ORCHESTRATOR TODO (optional hardening): add `Incident.groupKey String?` +
 * `@@index([orgId, status, groupKey])` to schema.prisma; this file then matches
 * on the column directly.
 *
 * Semantics:
 * - An OPEN incident for the groupKey exists → append the event (and escalate
 *   the incident to `critical` severity if the event is critical).
 * - None exists and severity is `critical` → open a new incident (human title
 *   derived from the groupKey via `incidentTitleForGroup`) with an `opened`
 *   event, then append the caller's event.
 * - None exists and severity is below critical → drop it (warnings only enrich
 *   an existing story; they never open one).
 * - A resolution kind (`resolved` / `*.resolved`) also closes the incident —
 *   the alert-evaluator signals recovery through this contract with kind
 *   `alert.resolved`, so the helper treats it as the story's final chapter.
 * - `resolveIncident(ctx, groupKey, message)` closes the open incident with a
 *   final `resolved` event (used by automation for auto-recovery).
 */

// ── Pure helpers (unit-tested in incidents-record.test.ts) ────────────────────

/** Only critical events open a new incident; lesser ones need an open story. */
export function opensIncident(severity: 'warning' | 'critical' | undefined): boolean {
  return severity === 'critical';
}

/** `resolved` / `*.resolved` kinds close the story they land on. */
export function kindIndicatesResolution(kind: string): boolean {
  return kind === 'resolved' || kind.endsWith('.resolved');
}

/** Pull the correlation key out of an event `meta` JSON blob. */
export function extractGroupKey(meta: unknown): string | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>).groupKey;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Human title for an auto-opened incident, derived from the groupKey
 * conventions used across the tree: `db:<cluster>` (A2 failover),
 * `release:<stack>` (D1 deploy safety), `alert:<resource>` where resource is
 * `<kind>:<name>` (C3 evaluator, e.g. `node:london-1`, `service:web`).
 */
export function incidentTitleForGroup(groupKey: string): string {
  const sep = groupKey.indexOf(':');
  if (sep <= 0) return `Incident: ${groupKey}`;
  const prefix = groupKey.slice(0, sep);
  const rest = groupKey.slice(sep + 1);
  switch (prefix) {
    case 'db':
      return `Database cluster ${rest} disruption`;
    case 'release':
      return `Failed deploy on ${rest}`;
    case 'alert': {
      const inner = rest.indexOf(':');
      if (inner > 0) {
        const kind = rest.slice(0, inner);
        const name = rest.slice(inner + 1);
        const label = kind.charAt(0).toUpperCase() + kind.slice(1);
        return `${label} ${name} disruption`;
      }
      return `Alert on ${rest}`;
    }
    default:
      return `Incident: ${groupKey}`;
  }
}

/**
 * Match an open incident by groupKey: the key lives in the opening event's
 * meta, so candidates are expected to carry their first (oldest) event(s).
 */
export function matchOpenIncident<T extends { events: Array<{ meta: unknown }> }>(
  incidents: T[],
  groupKey: string,
): T | null {
  for (const incident of incidents) {
    if (incident.events.some((e) => extractGroupKey(e.meta) === groupKey)) return incident;
  }
  return null;
}

// ── DB access ─────────────────────────────────────────────────────────────────

async function findOpenIncidentId(ctx: OrgContext, groupKey: string): Promise<string | null> {
  const open = await ctx.db.incident.findMany({
    where: { orgId: ctx.activeOrgId, status: 'OPEN' },
    select: {
      id: true,
      events: { orderBy: { at: 'asc' }, take: 1, select: { meta: true } },
    },
    orderBy: { openedAt: 'desc' },
  });
  return matchOpenIncident(open, groupKey)?.id ?? null;
}

/** Record one incident event under a correlation group key. */
export async function recordIncidentEvent(
  ctx: OrgContext,
  input: {
    groupKey: string;
    kind: string;
    message: string;
    severity?: 'warning' | 'critical';
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  const orgId = ctx.activeOrgId;
  const resolves = kindIndicatesResolution(input.kind);
  let incidentId = await findOpenIncidentId(ctx, input.groupKey);

  if (!incidentId) {
    if (resolves || !opensIncident(input.severity)) return; // nothing open to enrich
    const incident = await ctx.db.incident.create({
      data: {
        orgId,
        title: incidentTitleForGroup(input.groupKey),
        status: 'OPEN',
        severity: 'critical',
        events: {
          create: {
            orgId,
            kind: 'opened',
            message: `Incident opened (${input.groupKey})`,
            meta: { groupKey: input.groupKey },
          },
        },
      },
    });
    incidentId = incident.id;
    await writeAudit(ctx, {
      action: 'incidents.open',
      actorType: 'system',
      targetType: 'incident',
      targetId: incidentId,
      metadata: { groupKey: input.groupKey, title: incident.title },
    });
  } else if (input.severity === 'critical') {
    // A critical event escalates a lesser open incident.
    await ctx.db.incident.updateMany({
      where: { id: incidentId, orgId, NOT: { severity: 'critical' } },
      data: { severity: 'critical' },
    });
  }

  await ctx.db.incidentEvent.create({
    data: {
      orgId,
      incidentId,
      kind: input.kind,
      message: input.message,
      meta: { ...(input.meta ?? {}), groupKey: input.groupKey } as object,
    },
  });

  if (resolves) {
    await ctx.db.incident.update({
      where: { id: incidentId },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    await writeAudit(ctx, {
      action: 'incidents.autoResolve',
      actorType: 'system',
      targetType: 'incident',
      targetId: incidentId,
      metadata: { groupKey: input.groupKey, kind: input.kind },
    });
  }
}

/**
 * Auto-resolve the open incident for `groupKey`: status → resolved plus a
 * final `resolved` timeline event. No-op when nothing is open for the key.
 */
export async function resolveIncident(
  ctx: OrgContext,
  groupKey: string,
  message: string,
): Promise<void> {
  const incidentId = await findOpenIncidentId(ctx, groupKey);
  if (!incidentId) return;
  const now = new Date();
  await ctx.db.incident.update({
    where: { id: incidentId },
    data: { status: 'RESOLVED', resolvedAt: now },
  });
  await ctx.db.incidentEvent.create({
    data: {
      orgId: ctx.activeOrgId,
      incidentId,
      at: now,
      kind: 'resolved',
      message,
      meta: { groupKey } as object,
    },
  });
  await writeAudit(ctx, {
    action: 'incidents.autoResolve',
    actorType: 'system',
    targetType: 'incident',
    targetId: incidentId,
    metadata: { groupKey, message },
  });
}
