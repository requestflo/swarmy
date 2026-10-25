import { z } from '@hono/zod-openapi';
import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest } from '@swarmy/trpc';
import { ProblemDto } from './dto';

/**
 * Small shared pieces of a route definition (the problem response, a JSON
 * body/response, the `{id}` path param) and the one input check the governed
 * routes share, so each route module stays a list of `createRoute`s.
 */

export const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};

export const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
  required: true,
});

export const jsonRes = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});

export const idParam = z.object({ id: z.string().min(1).openapi({ param: { name: 'id', in: 'path' } }) });

/**
 * Parse a mapped body with the SAME `@swarmy/core` input schema the tRPC
 * procedure declares, so a request the dashboard would refuse is refused here
 * too (400, every issue in `detail`), and the defaults it fills are the same.
 */
export function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw badRequest(
    r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
  );
}
