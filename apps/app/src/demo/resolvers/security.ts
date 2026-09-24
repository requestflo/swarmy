import type { DemoStore, DomainResolvers } from '../types';

/**
 * Account-security demo resolvers (launch-blocker #7): the signed-in pilot's
 * 2FA status, the org "require 2FA" policy, member standings, the admin reset,
 * and the terminal policy (step-up window + idle / max session). Shapes mirror
 * security.service / terminal.service. Enrolment itself is Better Auth (no
 * tRPC), so in demo mode the "Set up" dialog cannot complete; everything else
 * reads and writes `store.extra.security`.
 */

type Require2fa = 'off' | 'admins' | 'all';

interface SecurityBag {
  enrolled: boolean;
  policy: { require2fa: Require2fa; graceDays: number; enforcedSince: Date | null; trustIdpMfa: boolean };
  terminal: {
    orgId: string;
    containerExecEnabled: boolean;
    nodeShellEnabled: boolean;
    requireMfa: boolean;
    requireApprovalForNodeShell: boolean;
    recordContainerExec: boolean;
    idleTimeoutMs: number;
    maxSessionMs: number;
    mfaMaxAgeMs: number;
  };
  members: Array<{
    memberId: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    enrolled: boolean;
    ssoOnly: boolean;
    joinedDaysAgo: number;
  }>;
}

const DAY = 86_400_000;

function bag(store: DemoStore): SecurityBag {
  return store.extra.security as SecurityBag;
}

function standing(b: SecurityBag, m: SecurityBag['members'][number]): { standing: string; deadline: Date | null } {
  const { require2fa, graceDays, enforcedSince, trustIdpMfa } = b.policy;
  const covered = require2fa === 'all' || (require2fa === 'admins' && m.role !== 'member');
  if (!covered) return { standing: 'not_required', deadline: null };
  if (m.enrolled) return { standing: 'enrolled', deadline: null };
  if (m.ssoOnly && trustIdpMfa) return { standing: 'exempt_sso', deadline: null };
  const start = Math.max((enforcedSince ?? new Date()).getTime(), Date.now() - m.joinedDaysAgo * DAY);
  const deadline = new Date(start + graceDays * DAY);
  return { standing: Date.now() < deadline.getTime() ? 'grace' : 'blocked', deadline };
}

export const security: DomainResolvers = {
  seed: (store) => {
    store.extra.security = {
      enrolled: true,
      policy: { require2fa: 'off', graceDays: 7, enforcedSince: null, trustIdpMfa: true },
      terminal: {
        orgId: store.org.id,
        containerExecEnabled: true,
        nodeShellEnabled: true,
        requireMfa: false,
        requireApprovalForNodeShell: true,
        recordContainerExec: true,
        idleTimeoutMs: 300_000,
        maxSessionMs: 3_600_000,
        mfaMaxAgeMs: 900_000,
      },
      members: [
        { memberId: 'mem-pilot', userId: store.user.id, name: store.user.name, email: store.user.email, role: 'owner', enrolled: true, ssoOnly: false, joinedDaysAgo: 200 },
        { memberId: 'mem-ava', userId: 'user-ava', name: 'Ava Chen', email: 'ava@northwind.dev', role: 'admin', enrolled: false, ssoOnly: false, joinedDaysAgo: 120 },
        { memberId: 'mem-rui', userId: 'user-rui', name: 'Rui Costa', email: 'rui@northwind.dev', role: 'admin', enrolled: false, ssoOnly: true, joinedDaysAgo: 90 },
        { memberId: 'mem-sam', userId: 'user-sam', name: 'Sam Okafor', email: 'sam@northwind.dev', role: 'member', enrolled: true, ssoOnly: false, joinedDaysAgo: 30 },
      ],
    } satisfies SecurityBag;
  },
  handlers: {
    'security.me': (_input, store) => {
      const b = bag(store);
      return {
        enrolled: b.enrolled,
        hasPassword: true,
        mfaVerifiedAt: new Date(Date.now() - 5 * 60_000),
        mfaPending: false,
        org: {
          require2fa: b.policy.require2fa,
          graceDays: b.policy.graceDays,
          standing: b.enrolled ? 'enrolled' : 'grace',
          deadline: null,
          stepUpWindowMs: b.terminal.mfaMaxAgeMs,
        },
      };
    },
    'security.policy.get': (_input, store) => bag(store).policy,
    'security.policy.set': (input, store) => {
      const b = bag(store);
      const patch = input as Partial<SecurityBag['policy']>;
      const wasOff = b.policy.require2fa === 'off';
      b.policy = { ...b.policy, ...patch };
      if (b.policy.require2fa === 'off') b.policy.enforcedSince = null;
      else if (wasOff) b.policy.enforcedSince = new Date();
      return b.policy;
    },
    'security.members': (_input, store) => {
      const b = bag(store);
      return b.members.map((m) => ({ ...m, ...standing(b, m) }));
    },
    'security.resetMember': (input, store) => {
      const b = bag(store);
      const m = b.members.find((x) => x.memberId === (input as { memberId: string }).memberId);
      if (m) m.enrolled = false;
      return { ok: true };
    },
    'terminal.policy.get': (_input, store) => bag(store).terminal,
    'terminal.policy.set': (input, store) => {
      const b = bag(store);
      b.terminal = { ...b.terminal, ...(input as Partial<SecurityBag['terminal']>) };
      return b.terminal;
    },
  },
};
