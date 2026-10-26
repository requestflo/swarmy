import { describe, expect, test } from 'bun:test';
import { addressOptions, canEnterPath, pathRulesLine, ruleWho } from './path-rules-model';
import { simulateRequest } from './simulate';
import type { AppAccessPerson, AppAccessRoute } from './types';

const route: AppAccessRoute = {
  id: 'r1',
  serviceId: 's',
  serviceName: 'storefront_web',
  host: 'shop.example.com',
  path: '/',
  requireLogin: true,
  endUserAuth: false,
  pathRules: [{ path: '/admin/*', groups: ['sre'] }],
  pathRulesError: false,
};
const person = (memberId: string, groups: string[], canEnter = true): AppAccessPerson => ({
  memberId, name: memberId, email: `${memberId}@example.com`, role: 'member', groups, canEnter,
});
const ada = person('ada', ['eng']);
const grace = person('grace', ['sre']);

describe('path rules in the dashboard (the edge matcher, in words)', () => {
  test('each rule path is an address to simulate', () => {
    expect(addressOptions([route]).map((o) => o.label)).toEqual(['shop.example.com', 'shop.example.com/admin']);
  });

  test('canEnterPath agrees with the edge: narrows, never widens', () => {
    expect(canEnterPath(route, ada, '/orders')).toBe(true);
    expect(canEnterPath(route, ada, '/Admin/users')).toBe(false);
    expect(canEnterPath(route, grace, '/admin')).toBe(true);
    expect(canEnterPath(route, person('x', ['sre'], false), '/admin')).toBe(false);
    expect(canEnterPath({ ...route, pathRulesError: true }, grace, '/')).toBe(false);
  });

  test('the simulator turns Ada away at /admin and says why', () => {
    const sim = simulateRequest(route, ada, 'storefront', '/admin', [ada, grace]);
    expect(sim).toMatchObject({ outcome: 'denied', reaches: false });
    expect(sim.caption).toBe('ada is signed in, but /admin only admits group sre, so swarmy answers 403.');
    expect(simulateRequest(route, grace, 'storefront', '/admin').outcome).toBe('passes');
  });

  test('rules read as plain phrases', () => {
    expect(ruleWho({ path: '/ops', roles: ['owner', 'admin'], groups: ['sre'], people: ['ada'] }, [ada])).toBe('owners and admins, group sre and ada');
    expect(ruleWho({ path: '/x' }, [])).toBe('nobody');
    expect(pathRulesLine(route, [])).toBe(' /admin: group sre only.');
  });
});
