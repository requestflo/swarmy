import { describe, expect, test } from 'bun:test';
import { simulateRequest } from './simulate';
import type { AppAccessPerson, AppAccessRoute } from './types';

const route = (requireLogin: boolean, path = '/admin'): AppAccessRoute => ({
  id: 'r', serviceId: 's', serviceName: 'storefront_web', host: 'shop.example.com', path, requireLogin, endUserAuth: false,
});
const priya = (canEnter: boolean): AppAccessPerson => ({
  memberId: 'm1', name: 'Priya', email: 'priya@example.com', role: 'member', groups: ['ops'], canEnter,
});

describe('simulateRequest', () => {
  test('a public route goes straight to the app, for anyone', () => {
    expect(simulateRequest(route(false), null, 'storefront')).toMatchObject({ outcome: 'public', checked: false, reaches: true });
    expect(simulateRequest(route(false, '/'), null, 'storefront').caption).toBe('shop.example.com is public, so every request goes straight to storefront.');
  });
  test('a stranger on a protected route is sent to sign in', () => {
    expect(simulateRequest(route(true), null, 'storefront')).toMatchObject({ outcome: 'signin', checked: true, reaches: false });
  });
  test('an allowed member passes; a member the rules leave out gets 403', () => {
    expect(simulateRequest(route(true), priya(true), 'storefront')).toMatchObject({ outcome: 'passes', reaches: true });
    expect(simulateRequest(route(true), priya(false), 'storefront')).toMatchObject({ outcome: 'denied', reaches: false });
  });
});
