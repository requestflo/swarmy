import { describe, expect, it } from 'bun:test';
import {
  isAuthMethod,
  isSocialProvider,
  loadAuthConfig,
  loadSsoProviders,
  resolveSsoProviderByEmail,
  type ResolvedSsoProvider,
} from './config';
import type { DB } from '@swarmy/db';

const providers: ResolvedSsoProvider[] = [
  { providerId: 'acme', protocol: 'oidc', orgId: 'o1', domain: 'acme.com' },
  { providerId: 'globex', protocol: 'oidc', orgId: 'o2', domain: 'Globex.io' },
];

describe('resolveSsoProviderByEmail', () => {
  it('routes an email to its domain provider (case-insensitive)', () => {
    expect(resolveSsoProviderByEmail('jane@acme.com', providers)?.providerId).toBe('acme');
    expect(resolveSsoProviderByEmail('bob@GLOBEX.IO', providers)?.providerId).toBe('globex');
  });

  it('returns null for an unmatched domain', () => {
    expect(resolveSsoProviderByEmail('x@unknown.com', providers)).toBeNull();
  });

  it('returns null for a malformed email', () => {
    expect(resolveSsoProviderByEmail('not-an-email', providers)).toBeNull();
  });
});

describe('type guards', () => {
  it('recognises social providers', () => {
    expect(isSocialProvider('github')).toBe(true);
    expect(isSocialProvider('passkey')).toBe(false);
  });
  it('recognises auth methods', () => {
    expect(isAuthMethod('passkey')).toBe(true);
    expect(isAuthMethod('magic_link')).toBe(true);
    expect(isAuthMethod('github')).toBe(false);
  });
});

/** Minimal DB stub covering the two tables loadAuthConfig reads. */
function stubDb(rows: {
  authProviderConfig?: unknown[];
  ssoProvider?: unknown[];
}): DB {
  return {
    authProviderConfig: { findMany: async () => rows.authProviderConfig ?? [] },
    ssoProvider: { findMany: async () => rows.ssoProvider ?? [] },
  } as unknown as DB;
}

describe('loadAuthConfig method toggles', () => {
  it('reads passkey and magic-link toggles from rows', async () => {
    const db = stubDb({
      authProviderConfig: [
        { type: 'passkey', enabled: true, scopes: [], encryptedSecret: null, clientId: null },
        { type: 'magic_link', enabled: false, scopes: [], encryptedSecret: null, clientId: null },
      ],
    });
    const cfg = await loadAuthConfig(db);
    expect(cfg.passkey).toBe(true);
    expect(cfg.magicLink).toBe(false);
  });

  it('ignores social rows without credentials', async () => {
    const db = stubDb({
      authProviderConfig: [
        { type: 'github', enabled: true, scopes: [], encryptedSecret: null, clientId: null },
      ],
    });
    const cfg = await loadAuthConfig(db);
    expect(cfg.social.github).toBeUndefined();
  });
});

describe('loadSsoProviders', () => {
  it('maps enabled OIDC rows and parses metadata', async () => {
    const db = stubDb({
      ssoProvider: [
        {
          providerId: 'acme',
          protocol: 'oidc',
          orgId: 'o1',
          domain: 'acme.com',
          issuer: 'https://idp.acme.com',
          clientId: 'cid',
          encryptedSecret: null,
          metadata: { discoveryUrl: 'https://idp.acme.com/.well-known/openid-configuration', scopes: ['openid'] },
          mapping: { name: 'displayName' },
        },
      ],
    });
    const out = await loadSsoProviders(db);
    expect(out).toHaveLength(1);
    expect(out[0]!.providerId).toBe('acme');
    expect(out[0]!.protocol).toBe('oidc');
    expect(out[0]!.discoveryUrl).toBe('https://idp.acme.com/.well-known/openid-configuration');
    expect(out[0]!.scopes).toEqual(['openid']);
    expect(out[0]!.mapping).toEqual({ name: 'displayName' });
  });
});
