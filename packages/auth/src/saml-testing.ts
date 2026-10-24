import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { IdentityProvider, ServiceProvider } from 'samlify';
import { samlSpMetadataXml, type SamlSpUrls } from './saml';

/**
 * Test-only: a throwaway SAML IdP. The key and its self-signed X.509
 * certificate are generated per call (no fixture files, no real IdP), and
 * samlify signs the assertion exactly as an IdP that read swarmy's SP
 * metadata would.
 */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const SHA256_RSA = seq(der(0x06, Buffer.from('2a864886f70d01010b', 'hex')), Buffer.from([0x05, 0x00]));
const cn = (name: string) => seq(der(0x31, seq(der(0x06, Buffer.from('550403', 'hex')), der(0x0c, Buffer.from(name)))));
const utc = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

export interface TestKey {
  privateKeyPem: string;
  /** Base64 DER body, as an admin pastes it. */
  cert: string;
}

/** An RSA key and a self-signed certificate for it, valid for a day. */
export function selfSignedCert(name = 'swarmy test idp'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serial = randomBytes(8);
  serial[0]! &= 0x7f;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    SHA256_RSA,
    cn(name),
    seq(utc(new Date(now - 60_000)), utc(new Date(now + 86_400_000))),
    cn(name),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = sign('sha256', tbs, privateKey);
  const cert = seq(tbs, SHA256_RSA, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert: cert.toString('base64') };
}

export interface TestAssertion {
  /** The AuthnRequest ID this answers (from the sign-in redirect). */
  inResponseTo: string;
  nameId: string;
  attributes?: Record<string, string | string[]>;
  /** Override the audience (default: the SP entity id). */
  audience?: string;
  assertionId?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function responseXml(idp: { entityId: string }, sp: SamlSpUrls, a: TestAssertion): string {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000).toISOString();
  const attrs = Object.entries(a.attributes ?? {})
    .map(([k, v]) => `<saml:Attribute Name="${esc(k)}">${[v].flat().map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join('')}</saml:Attribute>`)
    .join('');
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${esc(sp.acsUrl)}" InResponseTo="${esc(a.inResponseTo)}">` +
    `<saml:Issuer>${esc(idp.entityId)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${esc(a.assertionId ?? `_a${randomBytes(8).toString('hex')}`)}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>${esc(idp.entityId)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${esc(a.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${esc(sp.acsUrl)}" InResponseTo="${esc(a.inResponseTo)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${now.toISOString()}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${esc(a.audience ?? sp.entityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion></samlp:Response>`
  );
}

/** A test IdP: its metadata XML, and signed (or deliberately unsigned) login responses. */
export function testIdp(entityId: string, ssoUrl: string, key: TestKey = selfSignedCert()) {
  const idp = IdentityProvider({
    entityID: entityId,
    privateKey: key.privateKeyPem,
    signingCert: key.cert,
    singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: ssoUrl }],
  });
  return {
    entityId,
    ssoUrl,
    cert: key.cert,
    metadataXml: (): string => idp.entityMeta.getMetadata(),
    /** Base64 `SAMLResponse` with the assertion signed by this IdP's key. */
    async signedResponse(sp: SamlSpUrls, a: TestAssertion): Promise<string> {
      const spEntity = ServiceProvider({ metadata: samlSpMetadataXml(sp) });
      const xml = responseXml({ entityId }, sp, a);
      const res = await idp.createLoginResponse(spEntity, { extract: { request: { id: a.inResponseTo } } }, 'post', {}, () => ({ id: 'r', context: xml }));
      return res.context;
    },
    unsignedResponse: (sp: SamlSpUrls, a: TestAssertion): string => Buffer.from(responseXml({ entityId }, sp, a)).toString('base64'),
  };
}
