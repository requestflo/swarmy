import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { deletePolicy, getPolicy, listPolicies, setPolicy } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAction, requireScope } from '../middleware';
import { RemovedDto } from '../dto';
import { PolicyBody, PolicyDto, PolicyList } from '../dto-policies';
import { policyToDto, setPolicyInput } from '../mappers-policies';
import { idParam, jsonBody, jsonRes, problemRes } from '../route-kit';
import { run } from '../respond';

/**
 * ABAC policies (`/v1/policies`) over `policies.service` — the twins of tRPC
 * `policies.list` (any member; seeds the defaults) and `policies.set|delete`
 * (`abacProcedure('policy.write')`: owners and admins by default). Writes go
 * through `setPolicy`/`deletePolicy`, so the document is compiled before it
 * is saved, a managed default can only be switched on/off, and a change that
 * would leave no owner able to change rules is refused (POLICY_LOCKOUT).
 */

const TAG = 'Policies';
const sec = [{ bearerApiKey: [] }];

export function registerPolicyRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get', path: '/policies', tags: [TAG], security: sec,
      summary: 'List access policies, highest priority first (seeds the defaults)',
      middleware: [requireScope('read')] as const,
      responses: { 200: jsonRes(PolicyList, 'Policies'), 401: problemRes },
    }),
    (c) =>
      run(c, async () => ({ data: (await listPolicies(c.get('orgCtx'))).map(policyToDto), next_cursor: null })),
  );

  app.openapi(
    createRoute({
      method: 'get', path: '/policies/{id}', tags: [TAG], security: sec,
      summary: 'Get one access policy',
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(PolicyDto, 'Policy'), 404: problemRes },
    }),
    (c) => run(c, async () => policyToDto(await getPolicy(c.get('orgCtx'), c.req.valid('param').id))),
  );

  app.openapi(
    createRoute({
      method: 'post', path: '/policies', tags: [TAG], security: sec,
      summary: 'Create an access policy (the document is validated first)',
      middleware: [requireScope('write'), requireAction('policy.write')] as const,
      request: { body: jsonBody(PolicyBody) },
      responses: { 201: jsonRes(PolicyDto, 'Created'), 400: problemRes, 403: problemRes },
    }),
    (c) => run(c, async () => policyToDto(await setPolicy(c.get('orgCtx'), setPolicyInput(c.req.valid('json')))), 201),
  );

  app.openapi(
    createRoute({
      method: 'put', path: '/policies/{id}', tags: [TAG], security: sec,
      summary: 'Replace an access policy (a default may only be switched on or off)',
      middleware: [requireScope('write'), requireAction('policy.write')] as const,
      request: { params: idParam, body: jsonBody(PolicyBody) },
      responses: { 200: jsonRes(PolicyDto, 'Updated'), 400: problemRes, 403: problemRes, 404: problemRes },
    }),
    (c) =>
      run(c, async () =>
        policyToDto(await setPolicy(c.get('orgCtx'), setPolicyInput(c.req.valid('json'), c.req.valid('param').id))),
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete', path: '/policies/{id}', tags: [TAG], security: sec,
      summary: 'Delete an access policy (defaults cannot be deleted)',
      middleware: [requireScope('write'), requireAction('policy.write')] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(RemovedDto, 'Deleted'), 400: problemRes, 403: problemRes, 404: problemRes },
    }),
    (c) =>
      run(c, async () => {
        const { id } = await deletePolicy(c.get('orgCtx'), c.req.valid('param').id);
        return { id, removed: true as const };
      }),
  );
}
