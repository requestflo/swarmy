import { SPMetadata } from 'samlify';
import type { ResolvedSsoProvider } from './config';
import { isReservedProviderId } from './account-linking';
import { idpPlaceholderEmail } from './identity-idp';

/**
 * Org SAML SSO through `@better-auth/sso`: what a stored `SsoProvider` row
 * (protocol `saml`) becomes, and the URLs the IdP is given. Pure — the plugin
 * wiring lives in saml-plugin.ts.
 *
 * Row → IdP: `issuer` is the IdP entity id, `metadata.entryPoint` its sign-on
 * URL (HTTP-Redirect), `metadata.cert` its signing certificate. A row missing
 * any of the three is stored but not served ({@link samlReady}).
 */

/** Better Auth paths (under `/api/auth`) the SAML flow uses; every other `/sso/*` 404s. */
export const SAML_ACS_PREFIX = '/sso/saml2/sp/acs/';
export const SAML_METADATA_PATH = '/sso/saml2/sp/metadata';
export const SAML_SIGN_IN_PATH = '/sign-in/sso';

const POST_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const NAMEID_UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';

/**
 * The plugin's assertion checks, pinned so an upgrade can't loosen them:
 * NotBefore/NotOnOrAfter required and within 3 minutes of our clock, no
 * deprecated algorithm (SHA-1, RSA1_5, 3DES), each assertion id accepted once
 * (reserved in `verification`). AuthnRequests are stored (and expire after 5
 * minutes) but the plugin can't match responses to them, so its check stays
 * inert (`allowIdpInitiated`) and swarmy refuses any response that answers no
 * stored request itself (saml-request.ts): no IdP-initiated sign-in.
 */
export const SAML_SECURITY = {
  enableInResponseToValidation: true,
  allowIdpInitiated: true,
  requestTTL: 5 * 60_000,
  clockSkew: 3 * 60_000,
  requireTimestamps: true,
  algorithms: { onDeprecated: 'reject' as const },
  enableSingleLogout: false,
};

/** The controller's public URL (what the IdP and the browser reach). */
export function ssoPublicBase(env: Record<string, string | undefined> = process.env): string {
  return (env.CONTROLLER_PUBLIC_URL ?? env.BETTER_AUTH_URL ?? 'http://localhost:3021').replace(/\/+$/, '');
}

export interface SamlSpUrls {
  /** The SP entity id (the IdP's "Audience" / "Identifier"): the metadata URL. */
  entityId: string;
  metadataUrl: string;
  /** Assertion Consumer Service (HTTP-POST): the IdP's "Reply URL". */
  acsUrl: string;
}

export function samlSpUrls(providerId: string, base: string = ssoPublicBase()): SamlSpUrls {
  const auth = `${base.replace(/\/+$/, '')}/api/auth`;
  const metadataUrl = `${auth}${SAML_METADATA_PATH}?providerId=${encodeURIComponent(providerId)}`;
  return { entityId: metadataUrl, metadataUrl, acsUrl: `${auth}${SAML_ACS_PREFIX}${encodeURIComponent(providerId)}` };
}

/** PEM or bare base64 → the bare base64 body samlify compares certificates by. */
export function normalizeCert(raw: string): string {
  return raw.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

/** Can this provider sign people in? Enabled rows only reach here (loadSsoProviders). */
export function samlReady(p: ResolvedSsoProvider): boolean {
  return p.protocol === 'saml' && !isReservedProviderId(p.providerId) && Boolean(p.issuer && p.entryPoint && p.cert);
}

/** The SP metadata the IdP imports: one HTTP-POST ACS, assertions must be signed. */
export function samlSpMetadataXml(urls: SamlSpUrls): string {
  return SPMetadata({
    entityID: urls.entityId,
    assertionConsumerService: [{ Binding: POST_BINDING, Location: urls.acsUrl }],
    wantAssertionsSigned: true,
    authnRequestsSigned: false,
    nameIDFormat: [NAMEID_UNSPECIFIED],
  }).getMetadata();
}

/**
 * A stored SAML provider as a `@better-auth/sso` `defaultSSO` entry. The
 * admin's mapping names the attributes (`email`, `name`, `id`, `groups`);
 * the plugin falls back to `email` → NameID and `displayName`.
 *
 * `wantAssertionsSigned` stays false: in the plugin it means "the outer
 * <Response> must be signed", which Entra ID and ADFS don't do by default.
 * samlify still refuses any response no signature by `cert` covers (on the
 * Response or the Assertion) and ignores certificates the message carries.
 */
export function toSamlProvider(p: ResolvedSsoProvider, base: string = ssoPublicBase()) {
  const urls = samlSpUrls(p.providerId, base);
  const m = p.mapping ?? {};
  return {
    providerId: p.providerId,
    domain: p.domain ?? '',
    samlConfig: {
      issuer: p.issuer ?? '',
      entryPoint: p.entryPoint ?? '',
      cert: normalizeCert(p.cert ?? ''),
      callbackUrl: urls.acsUrl,
      audience: urls.entityId,
      spMetadata: { entityID: urls.entityId, metadata: samlSpMetadataXml(urls) },
      wantAssertionsSigned: false,
      authnRequestsSigned: false,
      identifierFormat: NAMEID_UNSPECIFIED,
      mapping: {
        ...(m.id ? { id: m.id } : {}),
        email: m.email || 'email',
        ...(m.name ? { name: m.name } : {}),
        // Raw (multi-valued) group attribute, handed to provisionUser.
        extraFields: { groups: m.groups || 'groups' },
      },
    },
  };
}

/** `/sso/saml2/sp/acs/:providerId` → the provider id. */
export function samlProviderIdFromPath(path: string | undefined, params?: Record<string, unknown> | null): string | null {
  if (!path?.startsWith(SAML_ACS_PREFIX)) return null;
  const fromParams = params?.providerId;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  const tail = path.slice(SAML_ACS_PREFIX.length);
  return tail && !tail.startsWith(':') ? decodeURIComponent(tail) : null;
}

/**
 * The address a new SAML account gets. With no email attribute the plugin
 * hands over the NameID (lowercased); that is no address, so the account gets
 * the IdP placeholder hashed from the provider id and that subject, exactly as
 * an OIDC IdP without email does (identity-idp.ts).
 */
export function samlUserEmail(providerId: string, email: string): string {
  return email.includes('@') ? email : idpPlaceholderEmail(providerId, email);
}
