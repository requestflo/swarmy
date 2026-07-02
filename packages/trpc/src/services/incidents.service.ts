import type {
  IncidentDetailView,
  IncidentEventView,
  IncidentNoteInput,
  IncidentRefInput,
  IncidentSeverityView,
  IncidentStatusView,
  IncidentView,
  IncidentsListInput,
  IncidentsOverview,
  PublicIncidentView,
  ResolveIncidentInput,
} from '@swarmy/core';
import { INCIDENT_SEVERITIES } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';

/**
 * Incidents (slice C4) — the open/resolve lifecycle behind the Incidents page.
 *
 * Rows are written almost entirely by automation through
 * `incidents-record.ts` (`recordIncidentEvent` / `resolveIncident` — the
 * cross-slice contract used by the alert-evaluator, A2 failover promotion and
 * D1 deploy safety). This service is the human side: list open/past
 * incidents, read a timeline, add post-mortem notes, resolve or reopen by
 * hand. Every mutation is org-scoped + audited.
 */

// ── View mapping (pure) ───────────────────────────────────────────────────────

interface IncidentRow {
  id: string;
  title: string;
  status: 'OPEN' | 'RESOLVED';
  severity: string;
  summary: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
}

/** Clamp a free-form severity string to the view vocabulary. */
export function toSeverityView(severity: string): IncidentSeverityView {
  return (INCIDENT_SEVERITIES as readonly string[]).includes(severity)
    ? (severity as IncidentSeverityView)
    : 'major';
}

/** Open incidents: seconds open so far. Resolved: the full open→resolved span. */
export function incidentDurationSec(
  openedAt: Date,
  resolvedAt: Date | null,
  now = new Date(),
): number {
  const end = resolvedAt ?? now;
  return Math.max(0, Math.round((end.getTime() - openedAt.getTime()) / 1000));
}

function toStatusView(status: 'OPEN' | 'RESOLVED'): IncidentStatusView {
  return status === 'OPEN' ? 'open' : 'resolved';
}

function toIncidentView(
  row: IncidentRow,
  eventCount: number,
  lastEventAt: Date | null,
): IncidentView {
  return {
    id: row.id,
    title: row.title,
    status: toStatusView(row.status),
    severity: toSeverityView(row.severity),
    summary: row.summary,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    durationSec: incidentDurationSec(row.openedAt, row.resolvedAt),
    eventCount,
    lastEventAt: lastEventAt?.toISOString() ?? null,
  };
}

function toEventView(row: {
  id: string;
  at: Date;
  kind: string;
  message: string;
  meta: unknown;
}): IncidentEventView {
  const meta =
    row.meta !== null && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? (row.meta as Record<string, unknown>)
      : {};
  return { id: row.id, at: row.at.toISOString(), kind: row.kind, message: row.message, meta };
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Hero aggregates for the Incidents page. */
export async function overview(ctx: OrgContext): Promise<IncidentsOverview> {
  const orgId = ctx.activeOrgId;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [open, openCritical, resolved7d, total] = await Promise.all([
    ctx.db.incident.count({ where: { orgId, status: 'OPEN' } }),
    ctx.db.incident.count({ where: { orgId, status: 'OPEN', severity: 'critical' } }),
    ctx.db.incident.count({ where: { orgId, status: 'RESOLVED', resolvedAt: { gte: weekAgo } } }),
    ctx.db.incident.count({ where: { orgId } }),
  ]);
  return { open, openCritical, resolved7d, total };
}

/** Incidents, open first then newest first; optionally one status only. */
export async function listIncidents(
  ctx: OrgContext,
  input: IncidentsListInput,
): Promise<IncidentView[]> {
  const rows = await ctx.db.incident.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ...(input.status ? { status: input.status === 'open' ? 'OPEN' : 'RESOLVED' } : {}),
    },
    orderBy: [{ status: 'asc' }, { openedAt: 'desc' }], // OPEN sorts before RESOLVED
    take: input.limit,
    include: {
      _count: { select: { events: true } },
      events: { orderBy: { at: 'desc' }, take: 1, select: { at: true } },
    },
  });
  return rows.map((r) => toIncidentView(r, r._count.events, r.events[0]?.at ?? null));
}

/** One incident with its full timeline, oldest event first. */
export async function getIncident(
  ctx: OrgContext,
  input: IncidentRefInput,
): Promise<IncidentDetailView> {
  const row = await ctx.db.incident.findFirst({
    where: { id: input.id, orgId: ctx.activeOrgId },
    include: { events: { orderBy: { at: 'asc' } } },
  });
  if (!row) throw notFound('incident', input.id);
  const events = row.events.map(toEventView);
  return {
    ...toIncidentView(row, events.length, row.events.at(-1)?.at ?? null),
    events,
  };
}

/**
 * Public incident feed for status pages (slice C5): open incidents plus the
 * last 30 days of resolved ones, with a trimmed update feed and no meta.
 * `_pageId` is accepted for future per-page component scoping.
 */
export async function publicIncidents(
  ctx: OrgContext,
  _pageId?: string,
): Promise<PublicIncidentView[]> {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await ctx.db.incident.findMany({
    where: {
      orgId: ctx.activeOrgId,
      OR: [{ status: 'OPEN' }, { status: 'RESOLVED', resolvedAt: { gte: monthAgo } }],
    },
    orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
    take: 25,
    include: { events: { orderBy: { at: 'desc' }, take: 10 } },
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: toStatusView(row.status),
    severity: toSeverityView(row.severity),
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updates: row.events.map((e) => ({
      at: e.at.toISOString(),
      kind: e.kind,
      message: e.message,
    })),
  }));
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function requireIncident(ctx: OrgContext, id: string): Promise<IncidentRow> {
  const row = await ctx.db.incident.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('incident', id);
  return row;
}

/** Append a manual `note` event (post-mortem narration), attributed + audited. */
export async function addNote(
  ctx: OrgContext,
  input: IncidentNoteInput,
): Promise<IncidentEventView> {
  const incident = await requireIncident(ctx, input.id);
  const event = await ctx.db.incidentEvent.create({
    data: {
      orgId: ctx.activeOrgId,
      incidentId: incident.id,
      kind: 'note',
      message: input.message,
      meta: { author: ctx.user.name || ctx.user.email } as object,
    },
  });
  await writeAudit(ctx, {
    action: 'incidents.addNote',
    targetType: 'incident',
    targetId: incident.id,
    metadata: { eventId: event.id },
  });
  return toEventView(event);
}

/** Manually resolve an open incident: status flip + a final `resolved` event. */
export async function resolveIncidentManually(
  ctx: OrgContext,
  input: ResolveIncidentInput,
): Promise<IncidentDetailView> {
  const incident = await requireIncident(ctx, input.id);
  if (incident.status === 'RESOLVED') {
    throw commandRejected('this incident is already resolved');
  }
  const now = new Date();
  const message = input.message?.trim() || `Manually resolved by ${ctx.user.name || ctx.user.email}`;
  await ctx.db.incident.update({
    where: { id: incident.id },
    data: { status: 'RESOLVED', resolvedAt: now },
  });
  await ctx.db.incidentEvent.create({
    data: {
      orgId: ctx.activeOrgId,
      incidentId: incident.id,
      at: now,
      kind: 'resolved',
      message,
      meta: { manual: true } as object,
    },
  });
  await writeAudit(ctx, {
    action: 'incidents.resolve',
    targetType: 'incident',
    targetId: incident.id,
    metadata: { title: incident.title, message },
  });
  return getIncident(ctx, { id: incident.id });
}

/** Reopen a resolved incident (it turned out not to be over). */
export async function reopenIncident(
  ctx: OrgContext,
  input: IncidentRefInput,
): Promise<IncidentDetailView> {
  const incident = await requireIncident(ctx, input.id);
  if (incident.status === 'OPEN') {
    throw commandRejected('this incident is already open');
  }
  await ctx.db.incident.update({
    where: { id: incident.id },
    data: { status: 'OPEN', resolvedAt: null },
  });
  await ctx.db.incidentEvent.create({
    data: {
      orgId: ctx.activeOrgId,
      incidentId: incident.id,
      kind: 'reopened',
      message: `Reopened by ${ctx.user.name || ctx.user.email}`,
      meta: { manual: true } as object,
    },
  });
  await writeAudit(ctx, {
    action: 'incidents.reopen',
    targetType: 'incident',
    targetId: incident.id,
    metadata: { title: incident.title },
  });
  return getIncident(ctx, { id: incident.id });
}
