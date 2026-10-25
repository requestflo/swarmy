/**
 * Public DTOs for incidents (`/incidents`) and the alert events behind them
 * (`/alert-events`). Read-mostly: automation opens incidents and fires
 * events; a person resolves an incident or acknowledges an event.
 */
import { z } from '@hono/zod-openapi';
import { ALERT_EVENT_STATUSES, INCIDENT_SEVERITIES, INCIDENT_STATUSES } from '@swarmy/core';
import { listEnvelope } from './dto';

const q = (name: string) => ({ param: { name, in: 'query' as const } });
const limit = z.coerce.number().int().min(1).max(200).optional().openapi({ ...q('limit'), description: 'Default 50.' });

export const IncidentDto = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(INCIDENT_STATUSES),
    severity: z.enum(INCIDENT_SEVERITIES),
    summary: z.string().nullable().openapi({ description: 'The post-mortem summary, when someone wrote one.' }),
    opened_at: z.string(),
    resolved_at: z.string().nullable(),
    duration_sec: z.number().int().openapi({ description: 'Open: seconds so far. Resolved: the whole span.' }),
    event_count: z.number().int(),
    last_event_at: z.string().nullable(),
  })
  .openapi('Incident');

export const IncidentEventDto = z
  .object({
    id: z.string(),
    at: z.string(),
    kind: z.string().openapi({ description: 'opened, alert.fired, alert.resolved, db.failover, note, status.<phase>, resolved, reopened, … (open set).' }),
    message: z.string(),
    meta: z.record(z.unknown()),
  })
  .openapi('IncidentEvent');

// Flat (not `IncidentDto.extend`, which the spec renders as `allOf`).
export const IncidentDetailDto = z
  .object({ ...IncidentDto.shape, events: z.array(IncidentEventDto).openapi({ description: 'Oldest first.' }) })
  .openapi('IncidentDetail');

export const IncidentList = listEnvelope(IncidentDto, 'IncidentList');

export const IncidentsQuery = z.object({
  status: z.enum(INCIDENT_STATUSES).optional().openapi({ ...q('status'), description: 'Omit for every incident (open first).' }),
  limit,
});

export const ResolveIncidentBody = z
  .object({ message: z.string().max(4_000).optional().openapi({ description: 'The resolution, for the timeline.' }) })
  .openapi('ResolveIncidentRequest');

export const AlertEventDto = z
  .object({
    id: z.string(),
    rule_id: z.string().nullable(),
    rule_name: z.string().nullable(),
    signal: z.string(),
    severity: z.enum(['info', 'warning', 'critical']),
    resource: z.string(),
    message: z.string(),
    status: z.enum(ALERT_EVENT_STATUSES),
    notify: z.enum(['sent', 'held', 'muted', 'skipped']).openapi({
      description: 'Its firing notification went out, is held for quiet hours, was muted, or was skipped.',
    }),
    fired_at: z.string(),
    resolved_at: z.string().nullable(),
  })
  .openapi('AlertEvent');

export const AlertEventList = listEnvelope(AlertEventDto, 'AlertEventList');

export const AlertEventsQuery = z.object({
  status: z.enum(ALERT_EVENT_STATUSES).optional().openapi(q('status')),
  limit,
});
