import { isReservedProviderId } from './account-linking';
import type { ResolvedSsoProvider } from './config';
import { samlReady } from './saml';

/**
 * Can this (enabled) org SSO provider sign people in right now? The same test
 * `buildAuth` registers providers by: an OIDC row needs a client id, a secret
 * and somewhere to discover the IdP; a SAML row needs the IdP's entity id,
 * sign-on URL and certificate. "Members sign in with SSO only" needs one.
 */
export function ssoProviderReady(p: ResolvedSsoProvider): boolean {
  if (isReservedProviderId(p.providerId)) return false;
  if (p.protocol === 'saml') return samlReady(p);
  return Boolean(p.clientId && p.clientSecret && (p.discoveryUrl || p.issuer || p.authorizationUrl));
}
