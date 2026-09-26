import { describe, expect, it } from 'bun:test';
import {
  API_KEY_PRESETS,
  apiKeyExpiresAt,
  describeApiKey,
  keyReachesApp,
  presetOf,
  scopeSatisfies,
} from './api-keys';

describe('API key presets map to the real scopes', () => {
  it('Read-only is read; Deploy is read + deploy; Admin is every scope', () => {
    expect(API_KEY_PRESETS.read.scopes).toEqual(['read']);
    expect(API_KEY_PRESETS.deploy.scopes).toEqual(['read', 'deploy']);
    expect(API_KEY_PRESETS.admin.scopes).toEqual(['read', 'write', 'secrets.read']);
  });

  it('recognises a stored scope set as its preset, else custom', () => {
    expect(presetOf(['read'])).toBe('read');
    expect(presetOf(['deploy', 'read'])).toBe('deploy');
    expect(presetOf(['secrets.read', 'write', 'read'])).toBe('admin');
    expect(presetOf(['read', 'write'])).toBe('custom');
  });
});

describe('scopeSatisfies: write ⊇ deploy ⊇ read; secrets.read never implied', () => {
  it('read routes', () => {
    expect(scopeSatisfies(['read'], 'read')).toBe(true);
    expect(scopeSatisfies(['deploy'], 'read')).toBe(true);
    expect(scopeSatisfies(['write'], 'read')).toBe(true);
    expect(scopeSatisfies(['secrets.read'], 'read')).toBe(false);
  });
  it('deploy routes', () => {
    expect(scopeSatisfies(['read'], 'deploy')).toBe(false);
    expect(scopeSatisfies(['read', 'deploy'], 'deploy')).toBe(true);
    expect(scopeSatisfies(['write'], 'deploy')).toBe(true);
  });
  it('write routes: a Deploy key is refused org-wide mutations', () => {
    expect(scopeSatisfies(['read', 'deploy'], 'write')).toBe(false);
    expect(scopeSatisfies(['write'], 'write')).toBe(true);
  });
  it('secrets.read is only ever explicit', () => {
    expect(scopeSatisfies(['write'], 'secrets.read')).toBe(false);
    expect(scopeSatisfies(['secrets.read'], 'secrets.read')).toBe(true);
  });
});

describe('expiry and app reach', () => {
  const now = new Date('2026-09-26T00:00:00Z');
  it('30 d / 90 d / 1 y / never', () => {
    expect(apiKeyExpiresAt('30d', now)?.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(apiKeyExpiresAt('90d', now)?.toISOString()).toBe('2026-12-25T00:00:00.000Z');
    expect(apiKeyExpiresAt('1y', now)?.toISOString()).toBe('2027-09-26T00:00:00.000Z');
    expect(apiKeyExpiresAt('never', now)).toBeNull();
  });
  it('null app list reaches every app; a list reaches only its apps', () => {
    expect(keyReachesApp(null, 'shop')).toBe(true);
    expect(keyReachesApp(['shop'], 'shop')).toBe(true);
    expect(keyReachesApp(['shop'], 'api')).toBe(false);
    expect(keyReachesApp(['shop'], null)).toBe(false);
  });
  it('says what the key can do in a sentence', () => {
    expect(describeApiKey({ preset: 'deploy', stackNames: ['storefront', 'api'], expiry: '90d' })).toBe(
      'This key can see and ship storefront and api, and put back an earlier version. It stops working in 90 days.',
    );
    expect(describeApiKey({ preset: 'read', stackNames: null, expiry: 'never' })).toBe(
      'This key can see every app, but never change anything. It never expires, so revoke it when you are done.',
    );
  });
});
