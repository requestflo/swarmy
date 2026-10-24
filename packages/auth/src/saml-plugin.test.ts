import { describe, expect, it } from 'bun:test';
import type { DB } from '@swarmy/db';
import type { ResolvedSsoProvider } from './config';
import { ssoProviderIdFromPath } from './provisioning';
import { samlReady, samlSpUrls, samlUserEmail, toSamlProvider } from './saml';
import { samlPluginOptions, swarmySaml } from './saml-plugin';
import { answeredRequestId } from './saml-request';
import { buildAuth } from './server';

const BASE = 'https://swarmy.acme.test';
const CERT = 'MIIBszCCAVmgAwIBAgIJAL';

function row(over: Partial<ResolvedSsoProvider> = {}): ResolvedSsoProvider {
  return {
    providerId: 'acme',
    protocol: 'saml',
    orgId: 'org-1',
    domain: 'acme.test',
    issuer: 'https://idp.acme.test/saml',
    entryPoint: 'https://idp.acme.test/sso',
    cert: `-----BEGIN CERTIFICATE-----\n${CERT}\n-----END CERTIFICATE-----\n`,
    mapping: {},
    ...over,
  };
}

describe('toSamlProvider (stored row → @better-auth/sso defaultSSO)', () => {
  it('takes entry point, cert and issuer from the row; SP URLs from the public URL', () => {
    const p = toSamlProvider(row(), BASE);
    const urls = samlSpUrls('acme', BASE);
    expect(urls).toEqual({
      entityId: `${BASE}/api/auth/sso/saml2/sp/metadata?providerId=acme`,
      metadataUrl: `${BASE}/api/auth/sso/saml2/sp/metadata?providerId=acme`,
      acsUrl: `${BASE}/api/auth/sso/saml2/sp/acs/acme`,
    });
    expect(p.providerId).toBe('acme');
    expect(p.samlConfig).toMatchObject({
      issuer: 'https://idp.acme.test/saml',
      entryPoint: 'https://idp.acme.test/sso',
      cert: CERT,
      callbackUrl: urls.acsUrl,
      audience: urls.entityId,
      wantAssertionsSigned: false,
      authnRequestsSigned: false,
      mapping: { email: 'email', extraFields: { groups: 'groups' } },
    });
    expect(p.samlConfig.spMetadata.entityID).toBe(urls.entityId);
    expect(p.samlConfig.spMetadata.metadata).toContain('WantAssertionsSigned="true"');
    expect(p.samlConfig.spMetadata.metadata).toContain(`Location="${urls.acsUrl}"`);
  });

  it("maps the admin's attribute names", () => {
    const p = toSamlProvider(row({ mapping: { email: 'mail', name: 'cn', id: 'uid', groups: 'memberOf' } }), BASE);
    expect(p.samlConfig.mapping).toEqual({ id: 'uid', email: 'mail', name: 'cn', extraFields: { groups: 'memberOf' } });
  });

  it('serves only complete SAML rows with a usable provider id', () => {
    expect(samlReady(row())).toBe(true);
    expect(samlReady(row({ cert: null }))).toBe(false);
    expect(samlReady(row({ entryPoint: '' }))).toBe(false);
    expect(samlReady(row({ issuer: null }))).toBe(false);
    expect(samlReady(row({ providerId: 'github' }))).toBe(false);
    expect(samlReady(row({ protocol: 'oidc' }))).toBe(false);
    expect(swarmySaml([row({ cert: null }), row({ protocol: 'oidc' })], BASE)).toEqual([]);
  });
});

describe('samlPluginOptions (the pinned plugin settings)', () => {
  const o = samlPluginOptions([row()], BASE);
  it("leaves org binding to swarmy and never trusts the IdP's email_verified", () => {
    expect(o.organizationProvisioning).toEqual({ disabled: true });
    expect(o.providersLimit).toBe(0);
    expect(o.trustEmailVerified).toBe(false);
    expect(o.provisionUserOnEveryLogin).toBe(true);
  });
  it('pins timestamps, clock skew, algorithms and stored AuthnRequests', () => {
    expect(o.saml).toMatchObject({
      enableInResponseToValidation: true,
      requireTimestamps: true,
      clockSkew: 180_000,
      requestTTL: 300_000,
      algorithms: { onDeprecated: 'reject' },
      enableSingleLogout: false,
    });
  });
});

describe('SAML paths and identities', () => {
  it('routes the ACS to the provider for admission and provisioning', () => {
    expect(ssoProviderIdFromPath('/sso/saml2/sp/acs/:providerId', { providerId: 'acme' })).toBe('acme');
    expect(ssoProviderIdFromPath('/sso/saml2/sp/acs/acme')).toBe('acme');
    expect(ssoProviderIdFromPath('/sso/saml2/sp/metadata')).toBeNull();
  });
  it('keeps a real address, and hashes a bare NameID into the IdP placeholder', () => {
    expect(samlUserEmail('acme', 'alice@acme.test')).toBe('alice@acme.test');
    expect(samlUserEmail('acme', 'opaque-q9')).toMatch(/^[0-9a-f]{32}@acme\.idp\.swarmy\.invalid$/);
  });
  it('reads the answered request id off the Response root only', () => {
    const b64 = (x: string) => Buffer.from(x).toString('base64');
    const ns = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"';
    expect(answeredRequestId(b64(`<samlp:Response ${ns} ID="_r" InResponseTo="_req1"/>`))).toBe('_req1');
    expect(answeredRequestId(b64(`<samlp:Response ${ns} ID="_r"/>`))).toBeNull();
    expect(answeredRequestId('not base64 xml')).toBeNull();
  });
});

describe('the SAML guard (only metadata, ACS and sign-in, only for configured providers)', () => {
  const auth = buildAuth({ social: {}, sso: [row()] }, { db: {} as DB });
  const call = (path: string, init?: RequestInit) => auth.handler(new Request(`http://localhost:3021/api/auth${path}`, init));
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3021' }, body: JSON.stringify(body) });

  it('serves SP metadata for a configured provider', async () => {
    const res = await call('/sso/saml2/sp/metadata?providerId=acme');
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('WantAssertionsSigned="true"');
    expect(xml).toContain('/api/auth/sso/saml2/sp/acs/acme');
  });

  it("404s the plugin's provider CRUD, OIDC callbacks, SLO and unknown providers", async () => {
    for (const path of ['/sso/providers', '/sso/get-provider?providerId=acme', '/sso/callback/acme', '/sso/saml2/sp/slo/acme', '/sso/saml2/sp/metadata?providerId=evil']) {
      expect((await call(path)).status).toBe(404);
    }
    expect((await post('/sso/register', { providerId: 'evil', issuer: 'x', domain: 'acme.test' })).status).toBe(404);
    expect((await post('/sso/saml2/callback/acme', { SAMLResponse: 'x' })).status).toBe(404);
    expect((await post('/sso/saml2/sp/acs/evil', { SAMLResponse: 'x' })).status).toBe(404);
    expect((await post('/sign-in/sso', { providerId: 'evil', callbackURL: '/' })).status).toBe(404);
    expect((await post('/sign-in/sso', { email: 'a@acme.test', callbackURL: '/' })).status).toBe(404);
  });
});
