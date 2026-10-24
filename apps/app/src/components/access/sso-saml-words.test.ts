import { describe, expect, test } from 'bun:test';
import { certWords, samlMissing, samlPatch, testSignInUrl } from './sso-saml-words';

describe('samlPatch', () => {
  test('pasted metadata wins; the server reads the fields out of it', () => {
    expect(samlPatch({ issuer: 'x', entryPoint: 'https://idp/sso', cert: 'MII', metadataXml: ' <md:EntityDescriptor/> ' })).toEqual({
      issuer: 'x',
      metadata: { idpMetadataXml: '<md:EntityDescriptor/>', entryPoint: undefined, cert: undefined },
    });
  });
  test('fields by hand; a cleared field is dropped', () => {
    expect(samlPatch({ issuer: ' https://idp/saml ', entryPoint: 'https://idp/sso', cert: '', metadataXml: '' })).toEqual({
      issuer: 'https://idp/saml',
      metadata: { entryPoint: 'https://idp/sso', cert: undefined },
    });
  });
});

describe('samlMissing', () => {
  test('names what the IdP still owes', () => {
    expect(samlMissing(null, { entryPoint: null, certSubject: null })).toBe(
      "Waiting for your identity provider's entity ID, sign-on URL and signing certificate. Paste its metadata, or fill them in.",
    );
    expect(samlMissing('https://idp', { entryPoint: 'https://idp/sso', certSubject: null })).toBe(
      "Waiting for your identity provider's signing certificate. Paste its metadata, or fill them in.",
    );
  });
  test('nothing once live', () => {
    expect(samlMissing('https://idp', { entryPoint: 'https://idp/sso', certSubject: 'CN=idp' })).toBeNull();
  });
});

describe('certWords', () => {
  const now = Date.parse('2026-10-24T00:00:00Z');
  test('calm far out, a count inside 30 days, loud once expired', () => {
    expect(certWords('2027-03-03T00:00:00Z', now)).toBe('Certificate good until 3 Mar 2027.');
    expect(certWords('2026-11-01T00:00:00Z', now)).toBe('The signing certificate expires in 8 days (1 Nov 2026).');
    expect(certWords('2026-10-01T00:00:00Z', now)).toBe('The signing certificate expired on 1 Oct 2026. Sign-in fails until you paste the new one.');
    expect(certWords(null, now)).toBeNull();
  });
});

test('testSignInUrl', () => {
  expect(testSignInUrl('https://swarmy.acme.test/', 'acme')).toBe('https://swarmy.acme.test/login?sso=acme');
});
