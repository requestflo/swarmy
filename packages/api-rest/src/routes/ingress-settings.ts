import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { getIngressSettings, updateIngressSettings } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAdmin, requireScope } from '../middleware';
import { ProblemDto } from '../dto';
import { IngressSettingsDto, UpdateIngressSettingsBody } from '../dto-ingress';
import { ingressSettingsBodyToPatch, ingressSettingsToDto } from '../mappers-ingress';
import { run } from '../respond';

const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const settingsRes = { content: { 'application/json': { schema: IngressSettingsDto } } };

/**
 * The org's edge settings — one per org — over the same service as the
 * dashboard's `ingress.settings` / `ingress.updateSettings`. Reading is any
 * member (`read`); writing is admins and owners (`write`, the twin of the
 * `adminProcedure` setters).
 */
export function registerIngressSettingsRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/ingress/settings',
      tags: ['Ingress'],
      summary: 'Read the ingress settings',
      description:
        'Driver, topology, image, target nodes, TLS, tunnel, DNS provider, country database and automatic-address base. Secrets read back as set / not set, never their values.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { ...settingsRes, description: 'Settings' },
        401: problemRes,
      },
    }),
    (c) => run(c, async () => ingressSettingsToDto(await getIngressSettings(c.get('orgCtx')))),
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/ingress/settings',
      tags: ['Ingress'],
      summary: 'Change the ingress settings',
      description:
        'One write for every edge setting: the body is validated as a whole (nothing changes when any part is refused, and `invalid_params` names each refused field), saved, and the edge converges once. Fields left out keep their current value; `null` clears a nullable one. A topology change removes and recreates the edge service; the current topology is a no-op.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { body: { content: { 'application/json': { schema: UpdateIngressSettingsBody } } } },
      responses: {
        200: { ...settingsRes, description: 'Settings after the change' },
        400: { ...problemRes, description: 'Refused as a whole: `invalid_params` names every field and why; nothing changed' },
        403: problemRes,
        412: { ...problemRes, description: 'A precondition failed (no ingress node, or object storage off, for edge-per-node)' },
      },
    }),
    (c) =>
      run(c, async () => {
        const patch = ingressSettingsBodyToPatch(c.req.valid('json'));
        return ingressSettingsToDto(await updateIngressSettings(c.get('orgCtx'), patch));
      }),
  );
}
