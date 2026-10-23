import type { BaseContext } from '../context';

type ActiveOrgCtx = Pick<BaseContext, 'auth' | 'reqHeaders' | 'resHeaders'>;

/**
 * Make `organizationId` the session's active org AND hand the browser the
 * refreshed session cookies.
 *
 * Better Auth's `setActiveOrganization` rewrites the session row and re-issues
 * the session cookies, including the `session_data` cookie cache
 * (`session.cookieCache`, 60 s). Called server-side through `auth.api`, those
 * Set-Cookie headers are only returned with `returnHeaders: true`; dropping
 * them leaves the old cached session in the browser, so the next request
 * still reads the previous org until the cache expires. Forward them onto the
 * tRPC response (`ctx.resHeaders`) instead.
 */
export async function setActiveOrg(ctx: ActiveOrgCtx, organizationId: string): Promise<void> {
  const { headers } = await ctx.auth.api.setActiveOrganization({
    headers: ctx.reqHeaders,
    body: { organizationId },
    returnHeaders: true,
  });
  forwardSetCookies(headers, ctx.resHeaders);
}

/** Copy every Set-Cookie from a Better Auth result onto the outgoing response. */
export function forwardSetCookies(from: Headers | null | undefined, to: Headers | undefined): void {
  if (!from || !to) return;
  for (const cookie of from.getSetCookie()) to.append('set-cookie', cookie);
}
