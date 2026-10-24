import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { loadAuthConfig } from '@swarmy/auth';
import { testIdp } from '@swarmy/auth/testing';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { signInOptions } from './authConfig.service';
import { listSsoProviders, upsertSsoProvider } from './sso.service';

// The SAML admin path: what the IdP gives back is checked and stored as the
// three fields the auth build reads, and the view hands out the SP URLs.

let t: TestDb;
const ctx = () => ({ db: t.db, activeOrgId: 'org_a', user: { id: 'ann' } }) as unknown as OrgContext;
const idp = testIdp('https://idp.acme.test/saml', 'https://idp.acme.test/sso');
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof TRPCError ? e.code : String(e)));
const saved = process.env.CONTROLLER_PUBLIC_URL;

beforeAll(async () => {
  process.env.CONTROLLER_PUBLIC_URL = 'https://swarmy.acme.test';
  t = await createTestDb();
  await t.db.organization.create({ data: { id: 'org_a', name: 'Acme', slug: 'acme' } });
  await t.db.user.create({ data: { id: 'ann', name: 'Ann', email: 'ann@acme.test' } });
});
afterAll(async () => {
  if (saved === undefined) delete process.env.CONTROLLER_PUBLIC_URL;
  else process.env.CONTROLLER_PUBLIC_URL = saved;
  await t?.close();
});

describe('SAML provider setup', () => {
  it('a new provider shows the SP metadata + ACS URLs and is not live until the IdP side is set', async () => {
    const p = await upsertSsoProvider(ctx(), { providerId: 'acme', protocol: 'saml', domain: 'acme.test' });
    expect(p.saml).toEqual({
      entityId: 'https://swarmy.acme.test/api/auth/sso/saml2/sp/metadata?providerId=acme',
      metadataUrl: 'https://swarmy.acme.test/api/auth/sso/saml2/sp/metadata?providerId=acme',
      acsUrl: 'https://swarmy.acme.test/api/auth/sso/saml2/sp/acs/acme',
      entryPoint: null,
      ready: false,
      certSubject: null,
      certExpiresAt: null,
    });
    expect(await signInOptions(t.db)).toEqual([]);
    expect((await loadAuthConfig(t.db)).sso?.[0]?.cert).toBeNull();
  });

  it('reads pasted IdP metadata into issuer, sign-on URL and certificate (the XML is not kept)', async () => {
    const [p] = await listSsoProviders(ctx());
    const saved = await upsertSsoProvider(ctx(), {
      id: p!.id,
      providerId: 'acme',
      protocol: 'saml',
      domain: 'acme.test',
      metadata: { ...p!.metadata, idpMetadataXml: idp.metadataXml(), displayName: 'Acme SSO' },
    });
    expect(saved.issuer).toBe(idp.entityId);
    expect(saved.metadata).toEqual({ entryPoint: idp.ssoUrl, cert: idp.cert, displayName: 'Acme SSO' });
    expect(saved.saml).toMatchObject({ ready: true, entryPoint: idp.ssoUrl, certSubject: 'CN=swarmy test idp' });
    const resolved = (await loadAuthConfig(t.db)).sso?.[0];
    expect(resolved).toMatchObject({ protocol: 'saml', issuer: idp.entityId, entryPoint: idp.ssoUrl, cert: idp.cert, orgId: 'org_a' });
    expect(await signInOptions(t.db)).toEqual([{ kind: 'sso', id: 'acme', label: 'Acme SSO', protocol: 'saml' }]);
  });

  it('refuses a certificate that is not X.509, a non-http sign-on URL and junk metadata', async () => {
    const base = { providerId: 'globex', protocol: 'saml' as const, issuer: 'https://idp.globex.test' };
    expect(await code(upsertSsoProvider(ctx(), { ...base, metadata: { cert: 'not-a-cert' } }))).toBe('BAD_REQUEST');
    expect(await code(upsertSsoProvider(ctx(), { ...base, metadata: { entryPoint: 'javascript:alert(1)' } }))).toBe('BAD_REQUEST');
    expect(await code(upsertSsoProvider(ctx(), { ...base, metadata: { idpMetadataXml: '<html/>' } }))).toBe('BAD_REQUEST');
    expect(await t.db.ssoProvider.count({ where: { providerId: 'globex' } })).toBe(0);
  });

  it('accepts the fields by hand, PEM certificate included, stored as its base64 body', async () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${idp.cert.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    const p = await upsertSsoProvider(ctx(), {
      providerId: 'globex',
      protocol: 'saml',
      issuer: 'https://idp.globex.test',
      clientId: 'ignored',
      metadata: { entryPoint: 'https://idp.globex.test/sso', cert: pem },
    });
    expect(p.metadata.cert).toBe(idp.cert);
    expect(p.clientId).toBeNull();
    expect(p.saml?.ready).toBe(true);
  });
});
