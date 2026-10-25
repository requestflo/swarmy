import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { IncidentsListInput, AlertEventsInput } from '@swarmy/core';
import { ackAlertEvent, getIncident, listAlertEvents, listIncidents, resolveIncidentManually } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import {
  AlertEventDto,
  AlertEventList,
  AlertEventsQuery,
  IncidentDetailDto,
  IncidentList,
  IncidentsQuery,
  ResolveIncidentBody,
} from '../dto-incidents';
import { alertEventToDto, incidentDetailToDto, incidentToDto } from '../mappers-incidents';
import { idParam, jsonRes, parseWith, problemRes } from '../route-kit';
import { run } from '../respond';

/**
 * Incidents (`/v1/incidents`) and alert events (`/v1/alert-events`) over
 * `incidents.service` / `alerts.service` — the twins of tRPC
 * `incidents.list|get|resolve` and `alerts.events|ack`. Read-mostly: reads
 * are `read`; resolving an incident or acknowledging (manually resolving)
 * an event is `write`, any member as in the dashboard, audited by the service.
 */

const sec = [{ bearerApiKey: [] }];

export function registerIncidentRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get', path: '/incidents', tags: ['Incidents'], security: sec,
      summary: 'List incidents, open first then newest',
      middleware: [requireScope('read')] as const,
      request: { query: IncidentsQuery },
      responses: { 200: jsonRes(IncidentList, 'Incidents'), 400: problemRes, 401: problemRes },
    }),
    (c) =>
      run(c, async () => ({
        data: (await listIncidents(c.get('orgCtx'), parseWith(IncidentsListInput, c.req.valid('query')))).map(incidentToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'get', path: '/incidents/{id}', tags: ['Incidents'], security: sec,
      summary: 'Get one incident with its timeline (oldest event first)',
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(IncidentDetailDto, 'Incident'), 404: problemRes },
    }),
    (c) => run(c, async () => incidentDetailToDto(await getIncident(c.get('orgCtx'), c.req.valid('param')))),
  );

  app.openapi(
    createRoute({
      method: 'post', path: '/incidents/{id}/resolve', tags: ['Incidents'], security: sec,
      summary: 'Resolve an open incident (optional resolution message)',
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: { content: { 'application/json': { schema: ResolveIncidentBody } }, required: false } },
      responses: { 200: jsonRes(IncidentDetailDto, 'Resolved'), 400: problemRes, 404: problemRes },
    }),
    // The body is optional: without one (no content-type) it reads as `{}`.
    (c) =>
      run(c, async () =>
        incidentDetailToDto(
          await resolveIncidentManually(c.get('orgCtx'), { id: c.req.valid('param').id, ...c.req.valid('json') }),
        ),
      ),
  );

  app.openapi(
    createRoute({
      method: 'get', path: '/alert-events', tags: ['Alert Events'], security: sec,
      summary: 'List alert events (firing and resolved), newest first',
      middleware: [requireScope('read')] as const,
      request: { query: AlertEventsQuery },
      responses: { 200: jsonRes(AlertEventList, 'Events'), 400: problemRes, 401: problemRes },
    }),
    (c) =>
      run(c, async () => ({
        data: (await listAlertEvents(c.get('orgCtx'), parseWith(AlertEventsInput, c.req.valid('query')))).map(alertEventToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'post', path: '/alert-events/{id}/acknowledge', tags: ['Alert Events'], security: sec,
      summary: 'Acknowledge a firing alert event (resolves it; no recovery notification)',
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(AlertEventDto, 'Acknowledged'), 404: problemRes },
    }),
    (c) => run(c, async () => alertEventToDto(await ackAlertEvent(c.get('orgCtx'), c.req.valid('param')))),
  );
}
