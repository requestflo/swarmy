/** Incidents + alert events: view → DTO (camel → snake). */
import type { z } from '@hono/zod-openapi';
import type { AlertEventView, IncidentDetailView, IncidentView } from '@swarmy/core';
import type { AlertEventDto, IncidentDetailDto, IncidentDto } from './dto-incidents';

export function incidentToDto(v: IncidentView): z.infer<typeof IncidentDto> {
  return {
    id: v.id,
    title: v.title,
    status: v.status,
    severity: v.severity,
    summary: v.summary,
    opened_at: v.openedAt,
    resolved_at: v.resolvedAt,
    duration_sec: v.durationSec,
    event_count: v.eventCount,
    last_event_at: v.lastEventAt,
  };
}

export function incidentDetailToDto(v: IncidentDetailView): z.infer<typeof IncidentDetailDto> {
  return {
    ...incidentToDto(v),
    events: v.events.map((e) => ({ id: e.id, at: e.at, kind: e.kind, message: e.message, meta: e.meta })),
  };
}

export function alertEventToDto(v: AlertEventView): z.infer<typeof AlertEventDto> {
  return {
    id: v.id,
    rule_id: v.ruleId,
    rule_name: v.ruleName,
    signal: v.signal,
    severity: v.severity,
    resource: v.resource,
    message: v.message,
    status: v.status,
    notify: v.notify,
    fired_at: v.firedAt,
    resolved_at: v.resolvedAt,
  };
}
