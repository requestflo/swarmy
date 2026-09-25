import type { AuditEntryView, AuditFilterInput } from '@swarmy/core';
import { curl, restExchange, type CodeTab } from '@/components/calm';

/** The same trail over REST: GET /audit/export with the filters on screen. */
export function auditCode(filters: AuditFilterInput, entries: AuditEntryView[]): CodeTab[] {
  const q = new URLSearchParams();
  if (filters.actor) q.set('actor', filters.actor);
  if (filters.actorType) q.set('actor_type', filters.actorType);
  if (filters.action) q.set('action', filters.action);
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  const path = (format: string): string => `/audit/export?${new URLSearchParams([...q.entries(), ['format', format]]).toString()}`;
  const sample = entries.slice(0, 3).map((e) => ({
    ts: e.ts,
    actor_type: e.actorType,
    actor: e.actorLabel,
    action: e.action,
    resource_type: e.targetType,
    resource_id: e.targetId,
    metadata: e.metadata as never,
  }));
  return [
    { label: 'CSV', code: `${curl('GET', path('csv'))} \\\n  -o audit.csv` },
    { label: 'JSON', code: restExchange('GET', path('json'), sample) },
  ];
}
