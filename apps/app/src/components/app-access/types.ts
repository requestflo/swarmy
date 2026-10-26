import type { AppPathRule } from '@swarmy/core';

/**
 * The Access panel's view shapes — structural mirrors of
 * packages/trpc/src/services/app-access-admin.service.ts (query data is
 * assigned to these, so a server-side change that breaks them fails typecheck).
 */
export interface AppAccessRoute {
  id: string;
  serviceId: string;
  serviceName: string;
  host: string;
  path: string;
  requireLogin: boolean;
  endUserAuth: boolean;
  /** Per-path who-can-enter (`access.paths` on the route label). */
  pathRules: AppPathRule[];
  /** The label's path rules can't be read: the edge lets nobody in. */
  pathRulesError: boolean;
}

export interface AppAccessRules {
  everyone: boolean;
  groups: string[];
  people: string[];
}

export interface AppAccessPerson {
  memberId: string;
  name: string | null;
  email: string | null;
  role: string;
  groups: string[];
  canEnter: boolean;
}

export interface EndUserAuth {
  serviceName: string;
  running: boolean;
  providers: string[];
  email: string;
  allowedDomains: string[];
  database: 'sqlite' | 'postgres';
  providerSetup: { provider: string; secrets: string[]; callbackUrl: string | null }[];
}

export interface AppAccessViewData {
  stack: string;
  routes: AppAccessRoute[];
  rules: AppAccessRules;
  people: AppAccessPerson[];
  knownGroups: string[];
  endUserAuth: EndUserAuth | null;
}

/** One row of Recent sign-ins (mirrors app-access-sign-ins.ts `AppSignIn`). */
export interface AppSignIn {
  id: string;
  at: string;
  outcome: 'allowed' | 'denied';
  userId: string | null;
  name: string | null;
  email: string | null;
  host: string | null;
  path: string | null;
  via: string | null;
  reason: string | null;
}

/** The identity headers the app receives (shown so developers know what to read). */
export const IDENTITY_HEADERS = ['X-Swarmy-User', 'X-Swarmy-Email', 'X-Swarmy-Groups', 'X-Swarmy-Jwt'] as const;
