import { describe, expect, it } from 'bun:test';
import { assertHttpUrl, certInfo, MAX_IDP_METADATA_BYTES, parseIdpMetadata, SamlConfigError } from './saml-metadata';
import { normalizeCert } from './saml';
import { selfSignedCert, testIdp } from './saml-testing';

describe('parseIdpMetadata', () => {
  const idp = testIdp('https://idp.acme.test/saml', 'https://idp.acme.test/sso?tenant=1');

  it('reads entity id, HTTP-Redirect sign-on URL and signing certificate', () => {
    expect(parseIdpMetadata(idp.metadataXml())).toEqual({
      issuer: 'https://idp.acme.test/saml',
      entryPoint: 'https://idp.acme.test/sso?tenant=1',
      cert: idp.cert,
    });
  });

  it('refuses a DOCTYPE (entity expansion), oversize input and non-metadata', () => {
    const xml = idp.metadataXml();
    expect(() => parseIdpMetadata(`<!DOCTYPE x [<!ENTITY a "b">]>${xml}`)).toThrow(SamlConfigError);
    expect(() => parseIdpMetadata(xml + ' '.repeat(MAX_IDP_METADATA_BYTES))).toThrow(/100 KB/);
    expect(() => parseIdpMetadata('<html><body>login</body></html>')).toThrow(SamlConfigError);
  });

  it('refuses metadata with no redirect sign-on service', () => {
    const postOnly = idp.metadataXml().replace(/bindings:HTTP-Redirect/g, 'bindings:HTTP-POST');
    expect(() => parseIdpMetadata(postOnly)).toThrow(/HTTP-Redirect/);
  });
});

describe('certificate and URL checks', () => {
  it('accepts PEM or a bare body, refuses anything that is not X.509', () => {
    const { cert } = selfSignedCert('acme idp');
    const pem = `-----BEGIN CERTIFICATE-----\n${cert.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
    expect(normalizeCert(pem)).toBe(cert);
    expect(certInfo(pem).subject).toBe('CN=acme idp');
    expect(Date.parse(certInfo(cert).expiresAt)).toBeGreaterThan(Date.now());
    expect(() => certInfo('bm90IGEgY2VydA==')).toThrow(/X\.509/);
  });

  it('takes only http(s) sign-on URLs', () => {
    expect(assertHttpUrl(' https://idp.acme.test/sso ', 'x')).toBe('https://idp.acme.test/sso');
    expect(() => assertHttpUrl('javascript:alert(1)', 'The sign-on URL')).toThrow(/http\(s\)/);
    expect(() => assertHttpUrl('idp.acme.test', 'x')).toThrow(SamlConfigError);
  });
});
