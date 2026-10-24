import { describe, expect, test } from 'bun:test';
import { validateLoginSearch } from './login-search';

describe('validateLoginSearch', () => {
  test('keeps same-origin redirects, invite ids and SSO provider slugs', () => {
    expect(validateLoginSearch({ redirect: '/apps', invite: 'inv_1', sso: 'acme-saml' })).toEqual({
      redirect: '/apps',
      invite: 'inv_1',
      sso: 'acme-saml',
    });
  });
  test('drops anything off-shape', () => {
    expect(validateLoginSearch({ redirect: '//evil.test', invite: 'a b', sso: 'Acme/../x' })).toEqual({});
    expect(validateLoginSearch({ sso: 42 })).toEqual({});
  });
});
