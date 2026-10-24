/**
 * Demo stand-ins for the SAML half of `sso.*`: the SP URLs a provider shows,
 * and pasted IdP metadata read into the three IdP fields. The real server
 * parses with samlify and checks the certificate; the demo only pattern-reads
 * the XML so the form round-trips.
 */

export interface DemoSamlSetup {
  entityId: string;
  metadataUrl: string;
  acsUrl: string;
  entryPoint: string | null;
  ready: boolean;
  certSubject: string | null;
  certExpiresAt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The view's `saml` block for a demo row (null for OIDC). */
export function demoSamlSetup(
  base: string,
  row: { providerId: string; protocol: 'oidc' | 'saml'; issuer: string | null; metadata: Record<string, unknown> },
): DemoSamlSetup | null {
  if (row.protocol !== 'saml') return null;
  const metadataUrl = `${base}/api/auth/sso/saml2/sp/metadata?providerId=${row.providerId}`;
  const entryPoint = str(row.metadata.entryPoint);
  const cert = str(row.metadata.cert);
  return {
    entityId: metadataUrl,
    metadataUrl,
    acsUrl: `${base}/api/auth/sso/saml2/sp/acs/${row.providerId}`,
    entryPoint,
    ready: Boolean(str(row.issuer) && entryPoint && cert),
    certSubject: cert ? `CN=${row.providerId} idp` : null,
    certExpiresAt: cert ? '2027-10-24T00:00:00.000Z' : null,
  };
}

/** Read `metadata.idpMetadataXml` into issuer + entryPoint + cert (and drop the XML), as the server does. */
export function demoSamlInput(
  issuer: string | null,
  metadata: Record<string, unknown> | undefined,
): { issuer: string | null; metadata: Record<string, unknown> | undefined } {
  if (!metadata) return { issuer, metadata };
  const { idpMetadataXml, ...rest } = metadata;
  const xml = str(idpMetadataXml);
  if (!xml) return { issuer, metadata: rest };
  const entity = /entityID="([^"]+)"/.exec(xml)?.[1];
  const sso = /SingleSignOnService[^>]*HTTP-Redirect"[^>]*Location="([^"]+)"/.exec(xml)?.[1];
  const cert = /<(?:\w+:)?X509Certificate>([^<]+)</.exec(xml)?.[1]?.replace(/\s+/g, '');
  if (!entity || !sso || !cert) throw new Error('That is not SAML IdP metadata XML');
  return { issuer: entity, metadata: { ...rest, entryPoint: sso, cert } };
}
