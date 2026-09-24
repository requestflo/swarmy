import type { AppAccessRules, AppAccessViewData } from '@/components/app-access/types';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * App Access demo resolvers (dev-platform §2): Require login per route, who
 * can enter, and — for `storefront`, which has `auth:` — its own users. State
 * lives in `store.extra.appaccess`, keyed by stack.
 */

interface EndUserRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  emailVerified: boolean;
  disabled: boolean;
}

interface AppAccessState {
  login: Record<string, boolean>;
  rules: Record<string, AppAccessRules>;
  users: EndUserRow[];
}

const PEOPLE = [
  { memberId: 'm-owner', name: 'Calum MacRae', email: 'calum@example.com', role: 'owner', groups: ['platform'] },
  { memberId: 'm-ada', name: 'Ada Lovelace', email: 'ada@example.com', role: 'member', groups: ['engineering'] },
  { memberId: 'm-grace', name: 'Grace Hopper', email: 'grace@example.com', role: 'member', groups: ['engineering', 'sre'] },
  { memberId: 'm-alan', name: 'Alan Turing', email: 'alan@example.com', role: 'member', groups: ['sales'] },
];

function state(s: DemoStore): AppAccessState {
  const st = (s.extra.appaccess ??= {
    login: {},
    rules: {},
    users: [
      { id: 'eu1', email: 'jo@shopper.dev', name: 'Jo', createdAt: new Date(Date.now() - 86_400_000 * 9).toISOString(), emailVerified: true, disabled: false },
      { id: 'eu2', email: 'sam@shopper.dev', name: 'Sam', createdAt: new Date(Date.now() - 86_400_000 * 2).toISOString(), emailVerified: true, disabled: false },
    ],
  }) as AppAccessState;
  return st;
}

function view(s: DemoStore, stack: string): AppAccessViewData {
  const st = state(s);
  const rules = st.rules[stack] ?? { everyone: false, groups: [], people: [] };
  const hosts = stack === 'storefront' ? ['shop.acme.dev', 'api.acme.dev'] : [`${stack}.acme.dev`];
  const routes = hosts.map((host, i) => ({
    id: `${stack}|${host}`,
    serviceId: `svc-${stack}-${i}`,
    serviceName: `${stack}_${i === 0 ? 'web' : 'api'}`,
    host,
    path: '/',
    requireLogin: st.login[`${stack}|${host}`] ?? false,
    endUserAuth: false,
  }));
  const people = PEOPLE.map((p) => ({
    ...p,
    canEnter: p.role !== 'member' || rules.everyone || rules.people.includes(p.memberId) || p.groups.some((g) => rules.groups.includes(g)),
  }));
  return {
    stack,
    routes,
    rules,
    people,
    knownGroups: [...new Set(PEOPLE.flatMap((p) => p.groups))].sort(),
    endUserAuth:
      stack === 'storefront'
        ? {
            serviceName: 'storefront_swarmy-auth',
            running: true,
            providers: ['github', 'google'],
            email: 'magic-link',
            allowedDomains: [],
            database: 'postgres',
            providerSetup: ['github', 'google'].map((p) => ({
              provider: p,
              secrets: [`auth-${p}-client-id`, `auth-${p}-client-secret`],
              callbackUrl: `https://shop.acme.dev/auth/callback/${p}`,
            })),
          }
        : null,
  };
}

export const appaccess: DomainResolvers = {
  handlers: {
    'appAccess.get': (i, s) => view(s, (i as { stack: string }).stack),
    'appAccess.setRequireLogin': (i, s) => {
      const { stack, on, routeIds } = i as { stack: string; on: boolean; routeIds?: string[] };
      for (const r of view(s, stack).routes) if (!routeIds || routeIds.includes(r.id)) state(s).login[r.id] = on;
      return view(s, stack);
    },
    'appAccess.setRules': (i, s) => {
      const { stack, ...rules } = i as { stack: string } & AppAccessRules;
      state(s).rules[stack] = rules;
      return view(s, stack);
    },
    'appAccess.users': (_i, s) => ({ total: state(s).users.length, users: state(s).users }),
    'appAccess.setUserDisabled': (i, s) => {
      const { userId, disabled } = i as { userId: string; disabled: boolean };
      const u = state(s).users.find((x) => x.id === userId);
      if (u) u.disabled = disabled;
      return { id: userId, disabled };
    },
  },
};
