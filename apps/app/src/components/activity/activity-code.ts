import type { AuditEntryView } from '@swarmy/core';
import { curl, restExchange, type CodeTab } from '@/components/calm';

/** Code depth for the timeline: the audit export over REST (the one real endpoint for it). */
export function activityCode(audit: AuditEntryView[]): CodeTab[] {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 19) + 'Z';
  const sample = audit.slice(0, 3).map((a) => ({
    ts: a.ts,
    actor_type: a.actorType,
    actor: a.actorLabel,
    action: a.action,
    resource_type: a.targetType,
    resource_id: a.targetId,
  }));
  return [
    { label: 'REST', code: curl('GET', `/audit/export?format=json&from=${since}`) },
    { label: 'response', code: restExchange('GET', `/audit/export?format=json&from=${since}`, sample) },
    { label: 'CSV', code: curl('GET', '/audit/export?format=csv&actor_type=user') + ' \\\n  -o audit.csv' },
  ];
}
