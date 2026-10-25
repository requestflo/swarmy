import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createAlertRule,
  deleteAlertRule,
  getAlertRule,
  listAlertRules,
  resolveConfigRow,
  updateAlertRule,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAction, requireScope } from '../middleware';
import { RemovedDto } from '../dto';
import { AlertRuleDto, AlertRuleList, CreateAlertRuleBody, UpdateAlertRuleBody } from '../dto-alerts';
import { alertRuleToDto, createAlertRuleInput, updateAlertRuleInput } from '../mappers-alerts';
import { idParam, jsonBody, jsonRes, problemRes } from '../route-kit';
import { run } from '../respond';

/**
 * Alert rules (`/v1/alert-rules`) over `alerts.service` — the twins of tRPC
 * `alerts.rules|createRule|updateRule|deleteRule`. Reads are `read`; changes
 * are `write` (any member, as in the dashboard); a delete runs the
 * `alert.remove` policy step. Deleting a seeded default opts the org out of
 * it (the row stays hidden so it is never re-seeded).
 */

const TAG = 'Alert Rules';
const sec = [{ bearerApiKey: [] }];

export function registerAlertRuleRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get', path: '/alert-rules', tags: [TAG], security: sec,
      summary: 'List alert rules (seeds the per-signal defaults on first call)',
      middleware: [requireScope('read')] as const,
      responses: { 200: jsonRes(AlertRuleList, 'Rules'), 401: problemRes },
    }),
    (c) =>
      run(c, async () => ({
        data: (await listAlertRules(c.get('orgCtx'))).map(alertRuleToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'get', path: '/alert-rules/{id}', tags: [TAG], security: sec,
      summary: 'Get one alert rule',
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(AlertRuleDto, 'Rule'), 404: problemRes },
    }),
    (c) => run(c, async () => alertRuleToDto(await getAlertRule(c.get('orgCtx'), c.req.valid('param').id))),
  );

  app.openapi(
    createRoute({
      method: 'post', path: '/alert-rules', tags: [TAG], security: sec,
      summary: 'Create an alert rule for a signal, optionally narrowed to one app/part or server',
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(CreateAlertRuleBody) },
      responses: { 201: jsonRes(AlertRuleDto, 'Created'), 400: problemRes, 403: problemRes },
    }),
    (c) =>
      run(
        c,
        async () => alertRuleToDto(await createAlertRule(c.get('orgCtx'), createAlertRuleInput(c.req.valid('json')))),
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'patch', path: '/alert-rules/{id}', tags: [TAG], security: sec,
      summary: 'Update an alert rule (target, threshold, for-duration, channels, enabled)',
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: jsonBody(UpdateAlertRuleBody) },
      responses: { 200: jsonRes(AlertRuleDto, 'Updated'), 400: problemRes, 404: problemRes },
    }),
    (c) =>
      run(c, async () =>
        alertRuleToDto(
          await updateAlertRule(c.get('orgCtx'), updateAlertRuleInput(c.req.valid('param').id, c.req.valid('json'))),
        ),
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete', path: '/alert-rules/{id}', tags: [TAG], security: sec,
      summary: 'Delete an alert rule (a seeded default is opted out, never re-created)',
      middleware: [requireScope('write'), requireAction('alert.remove', resolveConfigRow('alertRule'))] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(RemovedDto, 'Deleted'), 403: problemRes, 404: problemRes },
    }),
    (c) =>
      run(c, async () => {
        const id = c.req.valid('param').id;
        await deleteAlertRule(c.get('orgCtx'), { id });
        return { id, removed: true as const };
      }),
  );
}
