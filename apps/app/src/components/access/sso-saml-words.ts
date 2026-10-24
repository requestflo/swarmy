import type { SamlSetup } from './access-shared';

/** What the admin typed for the IdP side of a SAML provider. */
export interface SamlFields {
  /** IdP entity id (stored as the provider's issuer). */
  issuer: string;
  /** IdP sign-on URL (HTTP-Redirect). */
  entryPoint: string;
  /** IdP signing certificate, PEM or base64. */
  cert: string;
  /** Pasted IdP metadata XML; when set, the server reads the three fields from it. */
  metadataXml: string;
}

/**
 * The `sso.upsert` slice for the IdP side. Pasted metadata wins over the
 * fields (the server reads issuer, sign-on URL and certificate out of it);
 * a cleared field is dropped, so the provider waits for it again.
 */
export function samlPatch(f: SamlFields): { issuer: string | null; metadata: Record<string, unknown> } {
  const xml = f.metadataXml.trim();
  if (xml) return { issuer: f.issuer.trim() || null, metadata: { idpMetadataXml: xml, entryPoint: undefined, cert: undefined } };
  return {
    issuer: f.issuer.trim() || null,
    metadata: { entryPoint: f.entryPoint.trim() || undefined, cert: f.cert.trim() || undefined },
  };
}

/** What still blocks sign-in, in words; null once it is live. */
export function samlMissing(issuer: string | null, s: Pick<SamlSetup, 'entryPoint' | 'certSubject'>): string | null {
  const missing = [!issuer && 'entity ID', !s.entryPoint && 'sign-on URL', !s.certSubject && 'signing certificate'].filter(
    (x): x is string => Boolean(x),
  );
  if (missing.length === 0) return null;
  const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`;
  return `Waiting for your identity provider's ${list}. Paste its metadata, or fill them in.`;
}

/** "Certificate good until 3 Mar 2027", or a warning inside 30 days. */
export function certWords(expiresAt: string | null, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  const date = new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (at <= now) return `The signing certificate expired on ${date}. Sign-in fails until you paste the new one.`;
  const days = Math.ceil((at - now) / 86_400_000);
  return days <= 30 ? `The signing certificate expires in ${days} day${days === 1 ? '' : 's'} (${date}).` : `Certificate good until ${date}.`;
}

/** The link that opens the sign-in page and starts this provider (`/login?sso=`). */
export function testSignInUrl(origin: string, providerId: string): string {
  return `${origin.replace(/\/+$/, '')}/login?sso=${encodeURIComponent(providerId)}`;
}
