import { X509Certificate } from 'node:crypto';
import { IdPMetadata } from 'samlify';
import { normalizeCert } from './saml';

/**
 * Admin input for a SAML provider, checked before it is stored: an IdP
 * metadata document is read into the three fields swarmy keeps (entity id,
 * sign-on URL, signing certificate), and a pasted certificate must be X.509.
 */

/** Same ceiling as the plugin's own `maxMetadataSize`. */
export const MAX_IDP_METADATA_BYTES = 100 * 1024;

export class SamlConfigError extends Error {
  override name = 'SamlConfigError';
}

export interface IdpMetadataFields {
  /** The IdP entity id (stored as the provider's `issuer`). */
  issuer: string;
  /** HTTP-Redirect single sign-on URL. */
  entryPoint: string;
  /** Signing certificate, base64 body. */
  cert: string;
}

export interface CertInfo {
  subject: string;
  /** ISO time the certificate stops being valid. */
  expiresAt: string;
}

/** Parse a certificate (PEM or base64 body), or refuse it. */
export function certInfo(raw: string): CertInfo {
  const body = normalizeCert(raw);
  try {
    const x = new X509Certificate(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`);
    return { subject: x.subject, expiresAt: new Date(x.validTo).toISOString() };
  } catch {
    throw new SamlConfigError('The signing certificate is not a valid X.509 certificate');
  }
}

/** An http(s) URL, or refuse it. */
export function assertHttpUrl(raw: string, what: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol === 'https:' || u.protocol === 'http:') return raw.trim();
  } catch {
    /* fall through */
  }
  throw new SamlConfigError(`${what} must be an http(s) URL`);
}

function list(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).filter((c): c is string => typeof c === 'string' && c.trim() !== '');
}

/** The certificate to trust: the first one valid now, else the first. */
function pickCert(certs: string[], now: Date): string | undefined {
  return (
    certs.find((c) => {
      try {
        const x = new X509Certificate(`-----BEGIN CERTIFICATE-----\n${normalizeCert(c)}\n-----END CERTIFICATE-----`);
        return new Date(x.validFrom) <= now && now <= new Date(x.validTo);
      } catch {
        return false;
      }
    }) ?? certs[0]
  );
}

/** Read an IdP metadata document (one EntityDescriptor with an IDPSSODescriptor). */
export function parseIdpMetadata(xml: string, now: Date = new Date()): IdpMetadataFields {
  if (Buffer.byteLength(xml, 'utf8') > MAX_IDP_METADATA_BYTES) {
    throw new SamlConfigError('The IdP metadata is larger than 100 KB');
  }
  // No DTDs: entity expansion is how XML parsers get turned against their host.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SamlConfigError('The IdP metadata must not carry a DOCTYPE');
  let meta: ReturnType<typeof IdPMetadata>;
  try {
    meta = IdPMetadata(xml);
  } catch {
    throw new SamlConfigError('That is not SAML IdP metadata XML');
  }
  const issuer = meta.getEntityID();
  const sso = meta.getSingleSignOnService('redirect');
  const cert = pickCert(list(meta.getX509Certificate('signing')), now);
  if (typeof issuer !== 'string' || !issuer.trim()) throw new SamlConfigError('The IdP metadata names no entityID');
  if (typeof sso !== 'string' || !sso) {
    throw new SamlConfigError('The IdP metadata has no HTTP-Redirect SingleSignOnService');
  }
  if (!cert) throw new SamlConfigError('The IdP metadata has no signing certificate');
  certInfo(cert);
  return { issuer: issuer.trim(), entryPoint: assertHttpUrl(sso, 'The sign-on URL'), cert: normalizeCert(cert) };
}
