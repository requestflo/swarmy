import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RestEnv } from '../middleware';

/**
 * Audit-log REST routes (export endpoint) — slice E5.
 *
 * Spine stub — slice E5 fills the real registration. Kept as a no-op so
 * `app.ts` can wire the call site before the slice lands.
 */
export function registerAuditRoutes(_app: OpenAPIHono<RestEnv>): void {}
