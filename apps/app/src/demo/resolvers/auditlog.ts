import type {
  AuditActorKind,
  AuditEntryView,
  AuditExportResult,
  AuditFacetsView,
  AuditPageView,
  AuditRetentionView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Audit-pack demo resolvers — the Audit surface (`/audit`): a 60-row seeded
 * timeline covering deploys, secrets, terminals, policies and backups so every
 * canned question has hits, plus facets, export and the retention setting.
 * Shapes mirror auditLog.service.ts views exactly (imported from @swarmy/core).
 */

interface AuditState {
  entries: AuditEntryView[];
  retentionDays: number | null;
}

const getState = (store: DemoStore): AuditState => store.extra.auditlog as AuditState;

const DEFAULT_RETENTION_DAYS = 365;

interface Actor {
  actorType: AuditActorKind;
  actorId: string | null;
  actorLabel: string;
}

const PILOT: Actor = { actorType: 'user', actorId: 'user-demo', actorLabel: 'Demo Pilot' };
const AVA: Actor = { actorType: 'user', actorId: 'user-ava', actorLabel: 'Ava Chen' };
const MARCO: Actor = { actorType: 'user', actorId: 'user-marco', actorLabel: 'Marco Ruiz' };
const CI_KEY: Actor = { actorType: 'apikey', actorId: 'key_ci7f2a91', actorLabel: 'API key key_ci7f' };
const SYSTEM: Actor = { actorType: 'system', actorId: null, actorLabel: 'swarmy' };
const AGENT: Actor = { actorType: 'agent', actorId: 'node-hz-w1', actorLabel: 'agent node-hz-w1' };

interface SeedEvent {
  actor: Actor;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** One realistic day-in-the-life batch, replayed with varying offsets. */
const SEED_EVENTS: SeedEvent[] = [
  { actor: AVA, action: 'stack.deploy', targetType: 'stack', targetId: 'storefront', metadata: { services: 4, images: ['ghcr.io/northwind/storefront:1.42.0'] } },
  { actor: CI_KEY, action: 'stack.deploy', targetType: 'stack', targetId: 'storefront', metadata: { services: 4, trigger: 'ci', commit: 'b31c9e2' } },
  { actor: MARCO, action: 'service.builder.deploy', targetType: 'service', targetId: 'media-worker', metadata: { image: 'ghcr.io/northwind/media-worker:0.9.3' } },
  { actor: SYSTEM, action: 'cicd.autodeploy', targetType: 'service', targetId: 'storefront_web', metadata: { build: 'bld-1187', image: 'ghcr.io/northwind/storefront:1.42.1' } },
  { actor: AVA, action: 'secrets.create', targetType: 'secret', targetId: 'stripe-api-key', metadata: { family: 'stripe-api-key', version: 1 } },
  { actor: AVA, action: 'secrets.rotate', targetType: 'secret', targetId: 'stripe-api-key', metadata: { family: 'stripe-api-key', version: 2, consumersUpdated: 2 } },
  { actor: MARCO, action: 'secrets.attach', targetType: 'secret', targetId: 'smtp-password', metadata: { family: 'smtp-password', service: 'storefront_web' } },
  { actor: PILOT, action: 'terminal.open', targetType: 'service', targetId: 'storefront_postgres-1', metadata: { kind: 'container', containerId: 'c9f2ab', nodeId: 'node-hz-m1' } },
  { actor: PILOT, action: 'terminal.open', targetType: 'node', targetId: 'node-hz-w1', metadata: { kind: 'nodeShell', approvalId: 'apr-2210' } },
  { actor: AVA, action: 'terminal.kill', targetType: 'session', targetId: 'sess-88d1', metadata: { reason: 'idle' } },
  { actor: PILOT, action: 'policy.update', targetType: 'policy', targetId: 'pol-prod-guard', metadata: { effect: 'deny', actions: ['service.remove'] } },
  { actor: PILOT, action: 'guardrails.rule.set', targetType: 'org', targetId: 'org-demo', metadata: { rule: 'noLatestTagInProd', enabled: true } },
  { actor: AVA, action: 'exposure.rules.set', targetType: 'org', targetId: 'org-demo', metadata: { enforce: true } },
  { actor: SYSTEM, action: 'backup.run', targetType: 'volume', targetId: 'storefront_pgdata', metadata: { snapshotId: 'rst-4f21', sizeBytes: 812_450_304 } },
  { actor: SYSTEM, action: 'db.backup', targetType: 'dbCluster', targetId: 'storefront-db', metadata: { kind: 'scheduled', durationMs: 42_180 } },
  { actor: MARCO, action: 'db.restore', targetType: 'dbCluster', targetId: 'storefront-db', metadata: { mode: 'clone-to-new-cluster', snapshot: 'rst-3e0a' } },
  { actor: SYSTEM, action: 'controller.backup.run', targetType: 'org', targetId: 'org-demo', metadata: { sizeBytes: 18_874_368 } },
  { actor: AVA, action: 'ingress.setOnDemandTls', targetType: 'org', targetId: 'org-demo', metadata: { enabled: true } },
  { actor: MARCO, action: 'geodns.upsertRecord', targetType: 'dnsRecord', targetId: 'shop.northwind.dev', metadata: { type: 'A', regions: ['eu', 'us'] } },
  { actor: AGENT, action: 'mesh.peer.join', targetType: 'node', targetId: 'node-hz-w2', metadata: { subnet: '10.90.0.0/24' } },
  { actor: PILOT, action: 'alerts.createRule', targetType: 'alertRule', targetId: 'queue-backlog', metadata: { signal: 'queue-depth', threshold: 1000 } },
  { actor: AVA, action: 'apiKey.create', targetType: 'apiKey', targetId: 'key_ci7f2a91', metadata: { scopes: ['read', 'write'], name: 'ci-deployer' } },
  { actor: SYSTEM, action: 'alert.fire', targetType: 'alertEvent', targetId: 'evt-disk-84', metadata: { signal: 'disk-usage', resource: 'node:hz-w2' } },
  { actor: PILOT, action: 'queues.retryFailed', targetType: 'queue', targetId: 'image-resize', metadata: { retried: 37 } },
];

function seedEntries(): AuditEntryView[] {
  const entries: AuditEntryView[] = [];
  const now = Date.now();
  const total = 60;
  for (let i = 0; i < total; i += 1) {
    const ev = SEED_EVENTS[i % SEED_EVENTS.length]!;
    // Newest first, spread over ~14 days with slightly irregular gaps.
    const ageMinutes = i * 336 + (i % 5) * 47 + (i % 3) * 13;
    entries.push({
      id: String(9000 - i),
      ts: new Date(now - ageMinutes * 60_000).toISOString(),
      actorType: ev.actor.actorType,
      actorId: ev.actor.actorId,
      actorLabel: ev.actor.actorLabel,
      action: ev.action,
      targetType: ev.targetType ?? null,
      targetId: ev.targetId ?? null,
      metadata: ev.metadata ?? {},
    });
  }
  return entries;
}

interface ListInput {
  actor?: string;
  actorType?: AuditActorKind;
  action?: string;
  actions?: string[];
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

function applyFilters(entries: AuditEntryView[], f: ListInput): AuditEntryView[] {
  const prefixes = [...(f.actions ?? []), ...(f.action ? [f.action] : [])];
  const from = f.from ? Date.parse(f.from) : null;
  let to = f.to ? Date.parse(f.to) : null;
  if (to !== null && f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) to += 24 * 60 * 60 * 1000 - 1;
  return entries.filter((e) => {
    if (f.actor && e.actorId !== f.actor) return false;
    if (f.actorType && e.actorType !== f.actorType) return false;
    if (prefixes.length > 0 && !prefixes.some((p) => e.action.startsWith(p))) return false;
    if (f.resourceType && e.targetType !== f.resourceType) return false;
    if (f.resourceId && e.targetId !== f.resourceId) return false;
    const t = Date.parse(e.ts);
    if (from !== null && !Number.isNaN(from) && t < from) return false;
    if (to !== null && !Number.isNaN(to) && t > to) return false;
    return true;
  });
}

function csvEscape(value: string): string {
  let v = value;
  if (/^[=+@\t]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replaceAll('"', '""')}"`;
  return v;
}

function toCsv(entries: AuditEntryView[]): string {
  const header = 'id,ts,actorType,actorId,actorLabel,action,targetType,targetId,metadata';
  const lines = entries.map((e) =>
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
  return `${[header, ...lines].join('\r\n')}\r\n`;
}

export const auditlog: DomainResolvers = {
  seed: (store) => {
    store.extra.auditlog = { entries: seedEntries(), retentionDays: null } satisfies AuditState;
  },

  handlers: {
    'audit.list': (i, s): AuditPageView => {
      const input = (i ?? {}) as ListInput;
      const limit = input.limit ?? 50;
      let rows = applyFilters(getState(s).entries, input).sort(
        (a, b) => Number(b.id) - Number(a.id),
      );
      if (input.cursor) rows = rows.filter((e) => Number(e.id) < Number(input.cursor));
      const page = rows.slice(0, limit);
      return {
        entries: page,
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },

    'audit.facets': (_i, s): AuditFacetsView => {
      const { entries } = getState(s);
      const actors = new Map<string, { actorType: AuditActorKind; label: string }>();
      for (const e of entries) {
        if (e.actorId) actors.set(e.actorId, { actorType: e.actorType, label: e.actorLabel });
      }
      return {
        actions: [...new Set(entries.map((e) => e.action))].sort(),
        actorTypes: [...new Set(entries.map((e) => e.actorType))].sort(),
        actors: [...actors.entries()]
          .map(([id, a]) => ({ id, actorType: a.actorType, label: a.label }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      };
    },

    'audit.export': (i, s): AuditExportResult => {
      const input = (i ?? {}) as ListInput & { format?: 'csv' | 'json' };
      const format = input.format ?? 'csv';
      const rows = applyFilters(getState(s).entries, input).sort(
        (a, b) => Number(b.id) - Number(a.id),
      );
      const stamp = new Date().toISOString().slice(0, 10);
      return format === 'json'
        ? {
            format: 'json',
            filename: `swarmy-audit-${stamp}.json`,
            contentType: 'application/json; charset=utf-8',
            content: JSON.stringify(rows, null, 2),
            rowCount: rows.length,
            truncated: false,
          }
        : {
            format: 'csv',
            filename: `swarmy-audit-${stamp}.csv`,
            contentType: 'text/csv; charset=utf-8',
            content: toCsv(rows),
            rowCount: rows.length,
            truncated: false,
          };
    },

    'audit.retention': (_i, s): AuditRetentionView => {
      const st = getState(s);
      return {
        days: st.retentionDays ?? DEFAULT_RETENTION_DAYS,
        isDefault: st.retentionDays === null,
      };
    },

    'audit.setRetention': (i, s): AuditRetentionView => {
      const { days } = i as { days: number };
      getState(s).retentionDays = days;
      return { days, isDefault: false };
    },
  },
};
