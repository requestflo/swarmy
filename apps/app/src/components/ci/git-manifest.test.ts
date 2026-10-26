import { describe, expect, test } from 'bun:test';
import { appCreatedHead, parseManifest } from './git-manifest';

describe('the GitHub App round trip', () => {
  test('the receipt names the App by its GitHub number (board 23: "App #41 created")', () => {
    expect(appCreatedHead({ appId: 41, name: 'swarmy-northwind' }, 'github.northwind.dev')).toBe('App #41 created on github.northwind.dev');
    // An older controller sends no number: the name stands in.
    expect(appCreatedHead({ appId: null, name: 'swarmy-northwind' }, 'github.com')).toBe('App swarmy-northwind created on github.com');
    expect(appCreatedHead(undefined, 'github.com')).toBe('Your GitHub App created on github.com');
  });

  test('the manifest preview reads the permissions and events it asks for', () => {
    const m = parseManifest(JSON.stringify({ name: 'swarmy-x', hook_attributes: { url: 'https://c/webhooks/github' }, default_permissions: { contents: 'read', checks: 'write' }, default_events: ['push'] }));
    expect(m).toEqual({ name: 'swarmy-x', webhook: 'https://c/webhooks/github', permissions: ['contents:read', 'checks:write'], events: ['push'], public: false });
    expect(parseManifest('not json')).toBeNull();
  });
});
