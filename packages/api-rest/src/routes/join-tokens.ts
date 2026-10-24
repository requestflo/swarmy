import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import { generateJoinToken, listJoinTokens, revokeJoinToken } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAction, requireAdmin, requireScope } from '../middleware';
import { ProblemDto, listEnvelope } from '../dto';
import { CreateJoinTokenBody, JoinTokenDto, JoinTokenIssuedDto, RevokedDto } from '../dto-extra';
import { joinTokenIssuedToDto, joinTokenToDto } from '../mappers-extra';
import { run } from '../respond';

/**
 * Join tokens — how a new server enrolls (the install one-liner carries one).
 * Thin adapters over `token.service` with the tRPC guards: listing is any
 * member (`orgProcedure`), minting is admin (`adminProcedure`), revoking is
 * the `token.revoke` policy step (`abacProcedure`). The plaintext token is
 * returned once, by the create; only its hash is stored.
 */

const TAG = 'Join tokens';
const JoinTokenList = listEnvelope(JoinTokenDto, 'JoinTokenList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = { content: { 'application/problem+json': { schema: ProblemDto } }, description: 'Problem' };

export function registerJoinTokenRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/join-tokens',
      tags: [TAG],
      summary: 'List join tokens (never the token itself)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: JoinTokenList } }, description: 'Join tokens, newest first' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listJoinTokens(c.get('orgCtx'));
        return { data: rows.map(joinTokenToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/join-tokens',
      tags: [TAG],
      summary: 'Create a join token (plaintext returned once)',
      description: 'Admins and owners only. Pass `token` to the agent installer as `SWARMY_JOIN_TOKEN` on the new server.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAdmin()] as const,
      request: { body: { content: { 'application/json': { schema: CreateJoinTokenBody } } } },
      responses: {
        201: {
          content: { 'application/json': { schema: JoinTokenIssuedDto } },
          description: 'Created — carries the plaintext token (shown once)',
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
          return joinTokenIssuedToDto(
            await generateJoinToken(c.get('orgCtx'), {
              ...(b.ttl_seconds !== undefined ? { ttlSeconds: b.ttl_seconds } : {}),
              ...(b.max_uses !== undefined ? { maxUses: b.max_uses } : {}),
              ...(b.label !== undefined ? { label: b.label } : {}),
              ...(b.profile !== undefined ? { profile: b.profile } : {}),
            }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/join-tokens/{id}',
      tags: [TAG],
      summary: 'Revoke a join token',
      description:
        'A revoked token enrolls nothing, and no longer re-adopts a server that joined with it (a reinstall needs a fresh token). Policy: `token.revoke`.',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write'), requireAction('token.revoke')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RevokedDto } }, description: 'Revoked' },
        403: problemRes,
        404: problemRes,
      },
    }),
    (c) => run(c, () => revokeJoinToken(c.get('orgCtx'), c.req.param('id'))),
  );
}
