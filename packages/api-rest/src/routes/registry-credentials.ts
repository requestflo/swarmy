import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  REGISTRY_PROVIDERS,
  deleteRegistryCredential,
  listRegistryCredentials,
  testRegistryCredential,
  updateRegistryCredential,
  upsertRegistryCredential,
  type RegistryCredentialView,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAction, requireScope } from '../middleware';
import { ProblemDto, listEnvelope } from '../dto';
import { run } from '../respond';

/**
 * Org registry credentials (`/v1/registry-credentials`) — third-party pull
 * logins (GHCR, Docker Hub, GitLab, ECR/GCR/ACR, generic) matched to images by
 * longest `host[/path]` prefix and injected on every pull/build. The token is
 * WRITE-ONLY: accepted on create/update, never returned (Terraform treats it as
 * a sensitive, non-refreshable attribute).
 */

const Provider = z.enum(REGISTRY_PROVIDERS).openapi('RegistryProvider');

const RegistryCredentialDto = z
  .object({
    id: z.string(),
    prefix: z.string().openapi({ example: 'ghcr.io/acme' }),
    provider: Provider,
    label: z.string().nullable(),
    username: z.string(),
    has_secret: z.literal(true),
    last_tested_at: z.string().nullable(),
    last_test_ok: z.boolean().nullable(),
    last_test_message: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('RegistryCredential');

const CreateRegistryCredentialBody = z
  .object({
    prefix: z.string().trim().min(1).max(255).openapi({ example: 'ghcr.io' }),
    username: z.string().trim().min(1).max(255),
    secret: z.string().min(1).max(16_384).openapi({ description: 'Token/password. Write-only; never returned.' }),
    provider: Provider.optional(),
    label: z.string().trim().max(120).nullable().optional(),
  })
  .openapi('CreateRegistryCredentialBody');

const UpdateRegistryCredentialBody = z
  .object({
    username: z.string().trim().min(1).max(255).optional(),
    secret: z.string().min(1).max(16_384).optional().openapi({ description: 'Rotate the token. Write-only.' }),
    provider: Provider.optional(),
    label: z.string().trim().max(120).nullable().optional(),
  })
  .openapi('UpdateRegistryCredentialBody');

const TestRegistryCredentialBody = z
  .object({ image: z.string().trim().max(512).optional().openapi({ example: 'ghcr.io/acme/web:1.2' }) })
  .openapi('TestRegistryCredentialBody');

const RegistryTestResultDto = z
  .object({
    ok: z.boolean(),
    status: z.enum(['ok', 'unauthorized', 'not_found', 'unreachable', 'error']),
    message: z.string(),
    checked_manifest: z.boolean(),
  })
  .openapi('RegistryTestResult');

const DeletedDto = z.object({ ok: z.literal(true) }).openapi('RegistryCredentialDeleted');
const RegistryCredentialList = listEnvelope(RegistryCredentialDto, 'RegistryCredentialList');

const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({ content: { 'application/json': { schema } } });
const TAG = 'Registry Credentials';

export function registryCredentialToDto(v: RegistryCredentialView): z.infer<typeof RegistryCredentialDto> {
  return {
    id: v.id,
    prefix: v.prefix,
    provider: v.provider,
    label: v.label,
    username: v.username,
    has_secret: true,
    last_tested_at: v.lastTestedAt,
    last_test_ok: v.lastTestOk,
    last_test_message: v.lastTestMessage,
    created_at: v.createdAt,
    updated_at: v.updatedAt,
  };
}

export function registerRegistryCredentialRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/registry-credentials',
      tags: [TAG],
      summary: 'List registry credentials (secrets never returned)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: RegistryCredentialList } }, description: 'Credentials' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => ({
        data: (await listRegistryCredentials(c.get('orgCtx'))).map(registryCredentialToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/registry-credentials',
      tags: [TAG],
      summary: 'Create a registry credential (or rotate the login for an existing prefix)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(CreateRegistryCredentialBody) },
      responses: {
        201: { content: { 'application/json': { schema: RegistryCredentialDto } }, description: 'Stored' },
        400: problemRes,
        403: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => registryCredentialToDto(await upsertRegistryCredential(c.get('orgCtx'), c.req.valid('json'))),
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/registry-credentials/{id}',
      tags: [TAG],
      summary: 'Update a registry credential (username/label, or rotate the secret)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: jsonBody(UpdateRegistryCredentialBody) },
      responses: {
        200: { content: { 'application/json': { schema: RegistryCredentialDto } }, description: 'Updated' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () =>
        registryCredentialToDto(
          await updateRegistryCredential(c.get('orgCtx'), { id: c.req.param('id'), ...c.req.valid('json') }),
        ),
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/registry-credentials/{id}',
      tags: [TAG],
      summary: 'Delete a registry credential',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('secret.delete')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: DeletedDto } }, description: 'Deleted' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => deleteRegistryCredential(c.get('orgCtx'), c.req.param('id'))),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/registry-credentials/{id}/test',
      tags: [TAG],
      summary: 'Test a stored credential (registry v2 auth; manifest HEAD when `image` is given)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: jsonBody(TestRegistryCredentialBody) },
      responses: {
        200: { content: { 'application/json': { schema: RegistryTestResultDto } }, description: 'Result' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const r = await testRegistryCredential(c.get('orgCtx'), { id: c.req.param('id'), image: c.req.valid('json').image });
        return { ok: r.ok, status: r.status, message: r.message, checked_manifest: r.checkedManifest };
      }),
  );
}
