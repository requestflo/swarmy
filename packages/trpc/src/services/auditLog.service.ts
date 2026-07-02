import type { DB, Prisma } from '@swarmy/db';
import { prisma } from '@swarmy/db';
import type {
  AuditActorKind,
  AuditEntryView,
  AuditExportInput,
  AuditExportResult,
  AuditFacetsView,
  AuditFilterInput,
  AuditPageView,
  AuditQueryInput,
  AuditRetentionView,
  SetAuditRetentionInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';

/**
 * Audit pack (slice E5) — compliance-grade querying over the AuditLog table
 * (the single writer is `audit.service.ts#writeAudit`).
 *
 * - Query: actor / actor-type / action-prefix / resource / date filters,
 *   keyset (id) cursor pagination, newest first, org-scoped always.
 * - Facets: distinct actions/actor-types/actors for the filter dropdowns,
 *   cached 60s per org (the log is append-heavy, dropdowns don't need realtime).
 * - Export: same filters rendered to CSV (RFC 4180 + formula-injection guard)
 *   or JSON, capped at {@link AUDIT_EXPORT_MAX_ROWS}; every export is itself
 *   audited. Also served over REST (`GET /api/v1/audit/export`).
 * - Retention: per-org setting persisted in `Organization.metadata` JSON
 *   (best-effort — see ORCHESTRATOR TODO for a dedicated column);
 *   `pruneAuditLogs(now)` is exported for the retention worker.
 */

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const AUDIT_EXPORT_MAX_ROWS = 10_000;
const FACETS_TTL_MS = 60_000;
const RETENTION_METADATA_KEY = 'auditRetentionDays';

// ── Filter → Prisma where (pure, unit-tested) ─────────────────────────────────

/** Build the org-scoped Prisma `where` for a set of audit filters. */
export function buildAuditWhere(orgId: string, f: AuditFilterInput): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = { orgId };
  if (f.actor) where.actorId = f.actor;
  if (f.actorType) where.actorType = f.actorType;
  if (f.resourceType) where.targetType = f.resourceType;
  if (f.resourceId) where.targetId = f.resourceId;

  const prefixes = [...(f.actions ?? []), ...(f.action ? [f.action] : [])].filter(Boolean);
  if (prefixes.length === 1) where.action = { startsWith: prefixes[0] };
  else if (prefixes.length > 1) where.OR = prefixes.map((p) => ({ action: { startsWith: p } }));

  const ts: Prisma.DateTimeFilter = {};
  if (f.from) {
    const from = new Date(f.from);
    if (!Number.isNaN(from.getTime())) ts.gte = from;
  }
  if (f.to) {
    const to = new Date(f.to);
    if (!Number.isNaN(to.getTime())) {
      // A bare `YYYY-MM-DD` upper bound means "through the end of that day".
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) to.setUTCHours(23, 59, 59, 999);
      ts.lte = to;
    }
  }
  if (ts.gte !== undefined || ts.lte !== undefined) where.ts = ts;
  return where;
}

// ── CSV rendering (pure, unit-tested) ─────────────────────────────────────────

/**
 * RFC 4180 escaping + a spreadsheet formula-injection guard: cells starting
 * with `=`, `+`, `@` or a tab get a leading apostrophe so Excel/Sheets treat
 * them as text (audit exports land in compliance spreadsheets).
 */
export function csvEscape(value: string): string {
  let v = value;
  if (/^[=+@\t]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replaceAll('"', '""')}"`;
  return v;
}

const CSV_COLUMNS = [
  'id',
  'ts',
  'actorType',
  'actorId',
  'actorLabel',
  'action',
  'targetType',
  'targetId',
  'metadata',
] as const;

/** Render audit entries to a CSV string (header row + one line per entry). */
export function renderAuditCsv(entries: AuditEntryView[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const e of entries) {
    lines.push(
      [
        e.id,
        e.ts,
        e.actorType,
        e.actorId ?? '',
        e.actorLabel,
        e.action,
        e.targetType ?? '',
        e.targetId ?? '',
        JSON.stringify(e.metadata),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ── Row → view projection ─────────────────────────────────────────────────────

interface AuditRow {
  id: bigint;
  ts: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
}

function asActorKind(raw: string): AuditActorKind {
  return raw === 'apikey' || raw === 'system' || raw === 'agent' ? raw : 'user';
}

/** Fallback label when the actor isn't a resolvable user. */
export function actorFallbackLabel(actorType: AuditActorKind, actorId: string | null): string {
  if (actorType === 'system') return 'swarmy';
  if (actorType === 'agent') return actorId ? `agent ${actorId}` : 'agent';
  if (actorType === 'apikey') return actorId ? `API key ${actorId.slice(0, 8)}` : 'API key';
  return actorId ?? 'unknown user';
}

function toView(row: AuditRow, userLabels: Map<string, string>): AuditEntryView {
  const actorType = asActorKind(row.actorType);
  const resolved =
    actorType === 'user' && row.actorId ? userLabels.get(row.actorId) : undefined;
  return {
    id: row.id.toString(),
    ts: row.ts.toISOString(),
    actorType,
    actorId: row.actorId,
    actorLabel: resolved ?? actorFallbackLabel(actorType, row.actorId),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata:
      row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

async function resolveUserLabels(db: DB, rows: AuditRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows.filter((r) => asActorKind(r.actorType) === 'user' && r.actorId).map((r) => r.actorId!),
    ),
  ];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.name || u.email]));
}

// ── Query ─────────────────────────────────────────────────────────────────────

/** The audit timeline, newest first, keyset-paginated on the row id. */
export async function queryAudit(ctx: OrgContext, input: AuditQueryInput): Promise<AuditPageView> {
  const where = buildAuditWhere(ctx.activeOrgId, input);
  if (input.cursor) where.id = { lt: BigInt(input.cursor) };
  const rows = await ctx.db.auditLog.findMany({
    where,
    orderBy: { id: 'desc' },
    take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  const userLabels = await resolveUserLabels(ctx.db, page);
  return {
    entries: page.map((r) => toView(r, userLabels)),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id.toString() ?? null) : null,
  };
}

// ── Facets (60s cache) ────────────────────────────────────────────────────────

const facetsCache = new Map<string, { at: number; data: AuditFacetsView }>();

/** Distinct actions / actor types / actors for the filter dropdowns. */
export async function getFacets(ctx: OrgContext): Promise<AuditFacetsView> {
  const hit = facetsCache.get(ctx.activeOrgId);
  if (hit && Date.now() - hit.at < FACETS_TTL_MS) return hit.data;

  const orgId = ctx.activeOrgId;
  const [actionRows, typeRows, actorRows] = await Promise.all([
    ctx.db.auditLog.findMany({
      where: { orgId },
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' },
      take: 500,
    }),
    ctx.db.auditLog.findMany({
      where: { orgId },
      select: { actorType: true },
      distinct: ['actorType'],
    }),
    ctx.db.auditLog.findMany({
      where: { orgId, actorId: { not: null } },
      select: { actorId: true, actorType: true },
      distinct: ['actorId'],
      orderBy: { id: 'desc' },
      take: 200,
    }),
  ]);

  const userIds = actorRows
    .filter((r) => asActorKind(r.actorType) === 'user' && r.actorId)
    .map((r) => r.actorId!);
  const users =
    userIds.length > 0
      ? await ctx.db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
  const labels = new Map(users.map((u) => [u.id, u.name || u.email]));

  const data: AuditFacetsView = {
    actions: actionRows.map((r) => r.action),
    actorTypes: [...new Set(typeRows.map((r) => asActorKind(r.actorType)))].sort(),
    actors: actorRows
      .filter((r): r is typeof r & { actorId: string } => r.actorId !== null)
      .map((r) => {
        const kind = asActorKind(r.actorType);
        return {
          id: r.actorId,
          actorType: kind,
          label: labels.get(r.actorId) ?? actorFallbackLabel(kind, r.actorId),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
  facetsCache.set(orgId, { at: Date.now(), data });
  return data;
}

// ── Export ────────────────────────────────────────────────────────────────────

/** Render the filtered log to a downloadable CSV/JSON string (≤10k rows). */
export async function exportAudit(
  ctx: OrgContext,
  input: AuditExportInput,
): Promise<AuditExportResult> {
  const where = buildAuditWhere(ctx.activeOrgId, input);
  const rows = await ctx.db.auditLog.findMany({
    where,
    orderBy: { id: 'desc' },
    take: AUDIT_EXPORT_MAX_ROWS + 1,
  });
  const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
  const page = rows.slice(0, AUDIT_EXPORT_MAX_ROWS);
  const userLabels = await resolveUserLabels(ctx.db, page);
  const entries = page.map((r) => toView(r, userLabels));

  const stamp = new Date().toISOString().slice(0, 10);
  const result: AuditExportResult =
    input.format === 'json'
      ? {
          format: 'json',
          filename: `swarmy-audit-${stamp}.json`,
          contentType: 'application/json; charset=utf-8',
          content: JSON.stringify(entries, null, 2),
          rowCount: entries.length,
          truncated,
        }
      : {
          format: 'csv',
          filename: `swarmy-audit-${stamp}.csv`,
          contentType: 'text/csv; charset=utf-8',
          content: renderAuditCsv(entries),
          rowCount: entries.length,
          truncated,
        };

  // Exporting the audit trail is itself a compliance-relevant action.
  await writeAudit(ctx, {
    action: 'audit.export',
    metadata: {
      format: result.format,
      rowCount: result.rowCount,
      truncated,
      filters: {
        actor: input.actor ?? null,
        actorType: input.actorType ?? null,
        action: input.action ?? null,
        actions: input.actions ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        from: input.from ?? null,
        to: input.to ?? null,
      },
    },
  });
  return result;
}

// ── Retention (org setting in Organization.metadata; pure parser tested) ──────

/** Parse the retention override out of the org's metadata JSON; null = unset. */
export function parseRetentionDays(metadata: string | null | undefined): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const v = (parsed as Record<string, unknown>)[RETENTION_METADATA_KEY];
    return typeof v === 'number' && Number.isInteger(v) && v >= 7 && v <= 3650 ? v : null;
  } catch {
    return null;
  }
}

export async function getRetention(ctx: OrgContext): Promise<AuditRetentionView> {
  const org = await ctx.db.organization.findUnique({
    where: { id: ctx.activeOrgId },
    select: { metadata: true },
  });
  const days = parseRetentionDays(org?.metadata);
  return { days: days ?? DEFAULT_AUDIT_RETENTION_DAYS, isDefault: days === null };
}

export async function setRetention(
  ctx: OrgContext,
  input: SetAuditRetentionInput,
): Promise<AuditRetentionView> {
  const org = await ctx.db.organization.findUnique({
    where: { id: ctx.activeOrgId },
    select: { metadata: true },
  });
  let existing: Record<string, unknown> = {};
  try {
    const parsed = org?.metadata ? (JSON.parse(org.metadata) as unknown) : {};
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Unparseable metadata — replace with a clean object carrying our key.
  }
  await ctx.db.organization.update({
    where: { id: ctx.activeOrgId },
    data: { metadata: JSON.stringify({ ...existing, [RETENTION_METADATA_KEY]: input.days }) },
  });
  await writeAudit(ctx, {
    action: 'audit.retention.set',
    targetType: 'org',
    targetId: ctx.activeOrgId,
    metadata: { days: input.days },
  });
  return { days: input.days, isDefault: false };
}

/**
 * Range-delete audit rows older than each org's retention window. Exported for
 * the retention worker (see ORCHESTRATOR TODO — `apps/api/src/workers/retention.ts`
 * is owned by the spine and calls this on its hourly tick).
 */
export async function pruneAuditLogs(
  now: Date,
  db: DB = prisma,
): Promise<{ orgs: number; deleted: number }> {
  const orgs = await db.organization.findMany({ select: { id: true, metadata: true } });
  let deleted = 0;
  for (const org of orgs) {
    const days = parseRetentionDays(org.metadata) ?? DEFAULT_AUDIT_RETENTION_DAYS;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const res = await db.auditLog
      .deleteMany({ where: { orgId: org.id, ts: { lt: cutoff } } })
      .catch(() => ({ count: 0 }));
    deleted += res.count;
  }
  return { orgs: orgs.length, deleted };
}
