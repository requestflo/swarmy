import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { createApiKey, listApiKeys, revokeApiKey } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto, listEnvelope } from '../dto';
import {
  ApiKeyDto,
  ApiKeyIssuedDto,
  CreateApiKeyBody,
  RevokedDto,
} from '../dto-extra';
import { apiKeyIssuedToDto, apiKeyToDto } from '../mappers-extra';
import { run } from '../respond';

const ApiKeyList = listEnvelope(ApiKeyDto, 'ApiKeyList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

export function registerApiKeyRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api-keys',
      tags: ['API Keys'],
      summary: 'List API keys',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: ApiKeyList } }, description: 'API keys' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listApiKeys(c.get('orgCtx'));
        return { data: rows.map(apiKeyToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api-keys',
      tags: ['API Keys'],
      summary: 'Create an API key (plaintext returned once)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(CreateApiKeyBody) },
      responses: {
        201: {
          content: { 'application/json': { schema: ApiKeyIssuedDto } },
          description: 'Created — carries the plaintext key (shown once)',
        },
        400: problemRes,
        403: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          return apiKeyIssuedToDto(
            await createApiKey(c.get('orgCtx'), { name: b.name, scopes: b.scopes }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api-keys/{id}',
      tags: ['API Keys'],
      summary: 'Revoke an API key',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RevokedDto } }, description: 'Revoked' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => revokeApiKey(c.get('orgCtx'), c.req.param('id'))),
  );
}
