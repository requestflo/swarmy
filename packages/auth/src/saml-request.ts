import { createAuthMiddleware } from 'better-auth/api';
import { Extractor } from 'samlify';
import { inviteIdFromRequest } from './invite-cookie';
import { SAML_ACS_PREFIX, SAML_SIGN_IN_PATH, samlProviderIdFromPath } from './saml';
import { BOUND_INVITE_KEY, bindableInvite, parseBoundInvite, type BindInviteDb, type BoundInvite } from './saml-invite';

/**
 * Every SAML response must answer a sign-in this controller started, once.
 *
 * `@better-auth/sso` 1.6.22 stores each AuthnRequest it issues, but checks
 * responses against `extract.inResponseTo`, a key samlify 2.15 never sets:
 * to the plugin every response looks IdP-initiated, so it either refuses all
 * of them or correlates none. swarmy does the correlation here instead, before
 * the plugin runs, and the plugin's own check stays inert (saml.ts).
 *
 * The id is the root `Response@InResponseTo`, read with samlify's own
 * extractor (the same parse samlify then checks). samlify refuses the response
 * unless that value is the signed `SubjectConfirmationData@InResponseTo` or
 * the whole Response is signed, so consuming it here is safe even though the
 * signature is verified afterwards.
 *
 * The record also carries the invite the sign-in started from, if any
 * (saml-invite.ts): written as the plugin stores it, handed on when consumed.
 */

/** The plugin's verification key for an AuthnRequest it issued. */
export const AUTHN_REQUEST_KEY_PREFIX = 'saml-authn-request:';

/** The plugin caps a response at 256 KB; base64 is 4/3 of that. */
const MAX_RESPONSE_B64 = 350_000;

/** The request id a base64 `SAMLResponse` says it answers, or null. */
export function answeredRequestId(samlResponse: string): string | null {
  if (samlResponse.length > MAX_RESPONSE_B64) return null;
  try {
    const xml = Buffer.from(samlResponse.replace(/\s+/g, ''), 'base64').toString('utf8');
    const v = Extractor.extract(xml, [{ key: 'response', localPath: ['Response'], attributes: ['InResponseTo'] }]).response;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

function readRecord(value: string): { providerId: string | null; invite: BoundInvite | null } {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const providerId = typeof parsed.providerId === 'string' ? parsed.providerId : null;
    return { providerId, invite: parseBoundInvite(parsed[BOUND_INVITE_KEY]) };
  } catch {
    return { providerId: null, invite: null };
  }
}

/**
 * `verification.create.before`: as the plugin stores an AuthnRequest during
 * `/sign-in/sso`, add the invite that request's cookie names (when it can
 * still admit someone). Every other verification row passes untouched.
 */
export function bindInviteToAuthnRequest(db: BindInviteDb) {
  return async (data: { identifier: string; value: string }, ctx: { path?: string; headers?: Headers | null; request?: Request | null } | null) => {
    if (ctx?.path !== SAML_SIGN_IN_PATH || !data.identifier.startsWith(AUTHN_REQUEST_KEY_PREFIX)) return;
    const invite = await bindableInvite(db, inviteIdFromRequest(ctx));
    const record = invite ? (JSON.parse(data.value) as unknown) : null;
    if (!record || typeof record !== 'object') return;
    return { data: { ...data, value: JSON.stringify({ ...record, [BOUND_INVITE_KEY]: invite }) } };
  };
}

/** Before-hook for the ACS: consume the answered AuthnRequest (handing on its invite) or refuse the response. */
export const requireAnsweredRequest = {
  matcher: (ctx: { path?: string }) => Boolean(ctx.path?.startsWith(SAML_ACS_PREFIX)),
  handler: createAuthMiddleware(async (ctx) => {
    const providerId = samlProviderIdFromPath(ctx.path, ctx.params as Record<string, unknown>);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const id = typeof body.SAMLResponse === 'string' ? answeredRequestId(body.SAMLResponse) : null;
    const record = id ? await ctx.context.internalAdapter.consumeVerificationValue(`${AUTHN_REQUEST_KEY_PREFIX}${id}`) : null;
    const answered = record ? readRecord(record.value) : null;
    if (answered && providerId && answered.providerId === providerId) {
      return answered.invite ? { context: { [BOUND_INVITE_KEY]: answered.invite } } : undefined;
    }
    ctx.context.logger.warn('SAML response refused: it answers no sign-in this controller started', { providerId });
    throw ctx.redirect(`${new URL(ctx.context.baseURL).origin}/login?error=saml_unsolicited`);
  }),
};
