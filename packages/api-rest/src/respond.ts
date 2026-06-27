import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { PROBLEM_CONTENT_TYPE, trpcErrorToProblem } from './problem';
import type { RestEnv } from './middleware';

/**
 * Run a service call and JSON-encode the result, mapping any thrown TRPCError to
 * an RFC 9457 problem response. Handlers stay one-liners with no logic.
 *
 * The return is cast because `@hono/zod-openapi` infers a per-route
 * `TypedResponse` union from the route's `responses` map; the runtime payloads
 * are validated by those same Zod schemas, so the cast is sound at runtime.
 */
export async function run<T>(
  c: Context<RestEnv>,
  fn: () => Promise<T>,
  status: 200 | 201 | 202 = 200,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  try {
    const data = await fn();
    return c.json(data as object, status);
  } catch (e) {
    const p = trpcErrorToProblem(e, c.req.path);
    return c.json(p, p.status as ContentfulStatusCode, { 'content-type': PROBLEM_CONTENT_TYPE });
  }
}
