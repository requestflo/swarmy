/**
 * Web analytics + session replay ingest (dev-platform epic §5 + §7), mounted
 * at `/_rum`. The edge maps `/_swarmy/*` on every RUM-enabled app domain onto
 * it, so the browser only ever talks to its own origin. Public by design —
 * the trust model (signed app token, caps, bot filter, rate limits) lives in
 * `@swarmy/trpc` `rum-ingest.ts`.
 */
import { Hono } from 'hono';
import { prisma } from '@swarmy/db';
import { authRegistry, CLIENT_IP_HEADER } from '@swarmy/auth';
import { handleRumRequest, systemContext, type RumIngestDeps } from '@swarmy/trpc';
import { hub } from './gateway';

const deps: RumIngestDeps = {
  ctxFor: (orgId) => systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId),
  clientIpHeader: CLIENT_IP_HEADER,
  allowHeadless: process.env.SWARMY_RUM_ALLOW_HEADLESS === '1',
};

export const rumApp = new Hono();
rumApp.all('/*', (c) => handleRumRequest(deps, c.req.raw));
