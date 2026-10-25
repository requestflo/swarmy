import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { getGuardrailsConfig, updateGuardrails } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAdmin, requireScope } from '../middleware';
import { GuardrailsDto, UpdateGuardrailsBody } from '../dto-guardrails';
import { guardrailsPatch, guardrailsToDto } from '../mappers-guardrails';
import { jsonBody, jsonRes, problemRes } from '../route-kit';
import { run } from '../respond';

/**
 * The org's guardrails (`/v1/guardrails`) over `guardrails.service` — the twin
 * of tRPC `guardrails.config` (any member; seeds the defaults on first read)
 * and of `guardrails.setSafetyMode` / `guardrails.setRule` (admins and owners,
 * each change audited as in the dashboard).
 */

const TAG = 'Guardrails';
const sec = [{ bearerApiKey: [] }];

export function registerGuardrailRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get', path: '/guardrails', tags: [TAG], security: sec,
      summary: 'Get the guardrails: production safety mode and every deploy rule',
      middleware: [requireScope('read')] as const,
      responses: { 200: jsonRes(GuardrailsDto, 'Guardrails'), 401: problemRes },
    }),
    (c) => {
      const ctx = c.get('orgCtx');
      return run(c, async () => guardrailsToDto(await getGuardrailsConfig(ctx), ctx.activeOrgId));
    },
  );

  app.openapi(
    createRoute({
      method: 'patch', path: '/guardrails', tags: [TAG], security: sec,
      summary: 'Change production safety mode and/or rules (enabled, severity, params)',
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { body: jsonBody(UpdateGuardrailsBody) },
      responses: { 200: jsonRes(GuardrailsDto, 'Guardrails as they now are'), 400: problemRes, 403: problemRes },
    }),
    (c) => {
      const ctx = c.get('orgCtx');
      return run(c, async () =>
        guardrailsToDto(await updateGuardrails(ctx, guardrailsPatch(c.req.valid('json'))), ctx.activeOrgId),
      );
    },
  );
}
