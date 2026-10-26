import type { AppSignIn } from '@/components/app-access/types';
import type { DomainResolvers } from '../types';

/**
 * Recent sign-ins demo (`appAccess.signIns`, board 65): the app's last few
 * sign-ins and refusals, newest first, the shape the audit-log read returns.
 */

const MIN = 60_000;

const ROWS: Array<Omit<AppSignIn, 'id' | 'at' | 'host'> & { ago: number }> = [
  { ago: 4, outcome: 'allowed', userId: 'u-grace', name: 'Grace Hopper', email: 'grace@example.com', path: '/admin', via: 'Okta (SSO)', reason: null },
  { ago: 19, outcome: 'denied', userId: 'u-alan', name: 'Alan Turing', email: 'alan@example.com', path: '/admin', via: null, reason: 'Not allowed under /admin' },
  { ago: 52, outcome: 'allowed', userId: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com', path: '/', via: 'GitHub', reason: null },
  { ago: 180, outcome: 'allowed', userId: 'u-owner', name: 'Calum MacRae', email: 'calum@example.com', path: '/orders', via: 'Password + 2FA', reason: null },
  { ago: 1440, outcome: 'denied', userId: 'u-sam', name: 'Sam Contractor', email: 'sam@contractor.dev', path: '/', via: null, reason: 'Not on the list of who can enter' },
];

function hostFor(stack: string): string {
  return stack === 'storefront' ? 'shop.northwind.dev' : `${stack}.northwind.dev`;
}

export const appaccessSignIns: DomainResolvers = {
  handlers: {
    'appAccess.signIns': (i) => {
      const { stack, limit } = i as { stack: string; limit?: number };
      const now = Date.now();
      return ROWS.slice(0, limit ?? 20).map(({ ago, ...r }, n) => ({
        ...r,
        id: `demo-signin-${n}`,
        at: new Date(now - ago * MIN).toISOString(),
        host: hostFor(stack),
      }));
    },
  },
};
