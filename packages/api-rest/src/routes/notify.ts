import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RestEnv } from '../middleware';

/**
 * Notification relay REST routes (`POST /v1/notify`) — slice F6.
 *
 * Spine stub — slice F6 fills the real registration. Kept as a no-op so
 * `app.ts` can wire the call site before the slice lands.
 */
export function registerNotifyRoutes(_app: OpenAPIHono<RestEnv>): void {}
