import { describe, expect, it } from 'bun:test';
import { appPathReadings, closestAppPathRule, decideAppPath, parseAppPathRules, ruleKey, type AppPathPrincipal } from './app-access-paths';

const ENG: AppPathPrincipal = { memberId: 'm_eng', role: 'member', groups: ['eng'] };
const ADMINS: AppPathPrincipal = { memberId: 'm_ops', role: 'member', groups: ['admins'] };
const OWNER: AppPathPrincipal = { memberId: 'm_own', role: 'owner', groups: [] };

/** "/admin/* → group admins only; everything else → any member" (the board's example). */
const RULES = [
  { path: '/admin/*', groups: ['admins'] },
  { path: '/', everyone: true },
];

describe('parseAppPathRules: an unparseable rule set fails closed (null)', () => {
  it('reads a valid set and treats a missing one as no rules', () => {
    expect(parseAppPathRules(undefined)).toEqual([]);
    expect(parseAppPathRules(RULES)).toEqual(RULES);
    expect(parseAppPathRules([{ path: '/internal' }])).toEqual([{ path: '/internal' }]);
  });

  it('refuses wrong shapes, unknown keys, bad paths and duplicates', () => {
    for (const bad of [
      'nope',
      { path: '/' },
      [null],
      [{ path: '/a', group: ['admins'] }],
      [{ path: '/a', groups: 'admins' }],
      [{ path: '/a', groups: [''] }],
      [{ path: '/a', everyone: 'yes' }],
      [{ path: '/a', roles: ['root'] }],
      [{ path: 'admin' }],
      [{ path: '/a/../b' }],
      [{ path: '/a//b' }],
      [{ path: '/a%2eb' }],
      [{ path: '/a?x=1' }],
      [{ path: '/a/*/b' }],
      [{ path: '/admin' }, { path: '/ADMIN/*' }],
      Array.from({ length: 51 }, (_, i) => ({ path: `/p${i}` })),
    ]) {
      expect(parseAppPathRules(bad)).toBeNull();
    }
  });

  it('keys a rule path on segments, case-insensitively', () => {
    expect(ruleKey('/Admin/*')).toBe('/admin');
    expect(ruleKey('/admin/')).toBe('/admin');
    expect(ruleKey('/*')).toBe('/');
    expect(ruleKey('/.well-known')).toBe('/.well-known');
  });
});

describe('appPathReadings: the edge reading first, then the ones an app might use', () => {
  it('decodes once, merges slashes, resolves dot segments, lowercases', () => {
    expect(appPathReadings('/Admin//x/./y/../z?q=/admin')?.[0]).toBe('/admin/x/z');
    expect(appPathReadings('/%61dmin')?.[0]).toBe('/admin');
    expect(appPathReadings('/public/%2e%2e/admin')).toEqual(['/admin', '/public/../admin']);
  });

  it('refuses paths that read differently in different apps', () => {
    for (const p of ['/%252e%252e/admin', '/a%zz', '/a%', '/admin%00', '/%C0%AE%C0%AE/admin', '/a\u0001']) {
      expect(appPathReadings(p)).toBeNull();
    }
  });
});

describe('decideAppPath: the closest rule must admit under every reading', () => {
  const admit = (who: AppPathPrincipal, uri: string) => decideAppPath(RULES, uri, who).admit;

  it('admits everyone outside /admin, only the group inside it', () => {
    for (const uri of ['/', '/orders?id=7', '/administrator', '/adminx/y']) expect(admit(ENG, uri)).toBe(true);
    for (const uri of ['/admin', '/admin/', '/admin/users?x=1']) {
      expect(admit(ENG, uri)).toBe(false);
      expect(admit(ADMINS, uri)).toBe(true);
    }
    expect(decideAppPath(RULES, '/admin/users', ENG)).toEqual({ admit: false, reason: 'path', rule: '/admin/*' });
  });

  it('is not fooled by case, double slashes, dot segments or encodings', () => {
    for (const uri of [
      '/ADMIN',
      '/Admin/Users',
      '//admin',
      '/x//..//admin',
      '/./admin',
      '/x/../admin',
      '/x/%2e%2e/admin',
      '/x/%2E%2E/admin/',
      '/%2e/admin',
      '/x%2f..%2fadmin',
      '/%61dmin',
      '/admin;jsessionid=1',
      '/admin;/users',
      '/admin\\users',
      '/admin/../orders', // an app that does not resolve ".." still sees /admin
    ]) {
      expect(admit(ENG, uri)).toBe(false);
    }
  });

  it('a permissive deeper rule never opens its restrictive parent by traversal', () => {
    const rules = [
      { path: '/admin', roles: ['owner'] },
      { path: '/admin/docs/*', everyone: true },
    ];
    expect(decideAppPath(rules, '/admin/docs/intro', ENG).admit).toBe(true);
    expect(decideAppPath(rules, '/admin/docs/../secret', ENG).admit).toBe(false);
    expect(decideAppPath(rules, '/admin/docs%2f..%2fsecret', ENG).admit).toBe(false);
    expect(decideAppPath(rules, '/admin/secret', OWNER).admit).toBe(true);
  });

  it('matches people by member id and roles by role', () => {
    const rules = [{ path: '/billing', people: ['m_eng'] }];
    expect(decideAppPath(rules, '/billing', ENG).admit).toBe(true);
    expect(decideAppPath(rules, '/billing', ADMINS).admit).toBe(false);
    expect(decideAppPath([{ path: '/ops', roles: ['owner', 'admin'] }], '/ops', OWNER).admit).toBe(true);
  });

  it('fails closed on an unparseable rule set or an unreadable path, but only with rules', () => {
    expect(decideAppPath('garbage', '/', ADMINS)).toEqual({ admit: false, reason: 'rules', rule: null });
    expect(decideAppPath(RULES, '/a%zz', ADMINS)).toEqual({ admit: false, reason: 'unreadable-path', rule: null });
    expect(decideAppPath(undefined, '/a%zz', ENG)).toEqual({ admit: true, rule: null });
  });

  it('picks the most specific prefix', () => {
    const rules = [{ path: '/' }, { path: '/a' }, { path: '/a/b/*' }];
    expect(closestAppPathRule(rules, '/a/b/c')?.path).toBe('/a/b/*');
    expect(closestAppPathRule(rules, '/a/bc')?.path).toBe('/a');
    expect(closestAppPathRule(rules, '/z')?.path).toBe('/');
    expect(closestAppPathRule([{ path: '/a' }], '/z')).toBeNull();
  });
});
