import type { IncidentDetailView } from '@swarmy/core';
import { curl, restExchange, type CodeTab, type Json } from '@/components/calm';

/**
 * Code depth for one incident: `GET /incidents/{id}` and, while it is open,
 * `POST /incidents/{id}/resolve` (openapi.json), with the response in the
 * REST shape (mappers-incidents.ts `incidentDetailToDto`, snake_case; the
 * owner is dashboard-only, so it isn't in it).
 */
export function incidentCode(i: IncidentDetailView): CodeTab[] {
  const dto = {
    id: i.id,
    title: i.title,
    status: i.status,
    severity: i.severity,
    summary: i.summary,
    opened_at: i.openedAt,
    resolved_at: i.resolvedAt,
    duration_sec: i.durationSec,
    event_count: i.eventCount,
    last_event_at: i.lastEventAt,
    events: i.events.map((e) => ({ id: e.id, at: e.at, kind: e.kind, message: e.message, meta: e.meta as Json })),
  };
  const calls = ['# This incident, with its timeline:', curl('GET', `/incidents/${i.id}`)];
  if (i.status === 'open') {
    calls.push('', '# Resolve it, with a closing note for the timeline:', curl('POST', `/incidents/${i.id}/resolve`, { message: '<what fixed it>' }));
  }
  return [
    { label: 'curl', code: calls.join('\n') },
    { label: 'response', code: restExchange('GET', `/incidents/${i.id}`, dto) },
  ];
}
