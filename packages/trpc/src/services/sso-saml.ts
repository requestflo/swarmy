import {
  assertHttpUrl,
  certInfo,
  normalizeCert,
  parseIdpMetadata,
  SamlConfigError,
  samlSpUrls,
  ssoPublicBase,
} from '@swarmy/auth';
import { badRequest } from '../errors';

/**
 * The SAML half of the SSO admin: what the IdP is given (SP entity id,
 * metadata URL, ACS URL) and what it gives back (its metadata XML, or entity
 * id + sign-on URL + signing certificate), checked before it is stored.
 * Signing in is @swarmy/auth's (saml-plugin.ts); a row missing any IdP field
 * is kept but not served until it is complete.
 */

export interface SamlSetupView {
  /** SP entity id (the IdP's Audience / Identifier). */
  entityId: string;
  /** SP metadata (XML) for IdPs that import it. */
  metadataUrl: string;
  /** Assertion Consumer Service (HTTP-POST): the IdP's Reply URL. */
  acsUrl: string;
  /** The IdP sign-on URL (`metadata.entryPoint`). */
  entryPoint: string | null;
  /** Entity id, sign-on URL and certificate are all set: sign-in is live. */
  ready: boolean;
  certSubject: string | null;
  certExpiresAt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function samlSetupView(row: { providerId: string; issuer: string | null; metadata: unknown }): SamlSetupView {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const cert = str(meta.cert);
  let info: { subject: string; expiresAt: string } | null = null;
  try {
    info = cert ? certInfo(cert) : null;
  } catch {
    info = null;
  }
  const entryPoint = str(meta.entryPoint);
  return {
    ...samlSpUrls(row.providerId, ssoPublicBase()),
    entryPoint,
    ready: Boolean(str(row.issuer) && entryPoint && info),
    certSubject: info?.subject ?? null,
    certExpiresAt: info?.expiresAt ?? null,
  };
}

interface SamlInput {
  issuer?: string | null;
  clientId?: string | null;
  clientSecret?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Normalise a SAML upsert: IdP metadata XML (`metadata.idpMetadataXml`) is read
 * into `issuer` + `metadata.entryPoint` + `metadata.cert` and not kept; a
 * pasted certificate must be X.509 and is stored as its base64 body; the
 * sign-on URL must be http(s). OIDC credentials never ride a SAML row.
 */
export function normalizeSamlInput<T extends SamlInput>(args: T): T {
  const { idpMetadataXml, ...meta } = { ...(args.metadata ?? {}) } as Record<string, unknown>;
  let issuer = args.issuer ?? null;
  try {
    const xml = str(idpMetadataXml);
    if (xml) {
      const parsed = parseIdpMetadata(xml);
      issuer = parsed.issuer;
      meta.entryPoint = parsed.entryPoint;
      meta.cert = parsed.cert;
    }
    const cert = str(meta.cert);
    if (cert) {
      certInfo(cert);
      meta.cert = normalizeCert(cert);
    } else delete meta.cert;
    const entryPoint = str(meta.entryPoint);
    if (entryPoint) meta.entryPoint = assertHttpUrl(entryPoint, 'The IdP sign-on URL');
    else delete meta.entryPoint;
  } catch (e) {
    if (e instanceof SamlConfigError) throw badRequest(e.message);
    throw e;
  }
  return {
    ...args,
    issuer,
    clientId: null,
    clientSecret: undefined,
    ...(args.metadata ? { metadata: meta } : {}),
  };
}
