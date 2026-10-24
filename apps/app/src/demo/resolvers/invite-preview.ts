import { simulateInvite, type InviteApp, type Role } from '@swarmy/abac/model';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Members & roles (board 48) in the demo: the invite form's live preview
 * (`policies.simulateInvite`, the same pure simulateInvite the controller
 * runs, over the demo org's rules) and Resend on a pending invite. Demo apps
 * read as production, as their services' `swarmy.env` labels do in the demo.
 */

interface DemoPolicy {
  id: string;
  name: string;
  effect: 'permit' | 'forbid';
  source: string;
  priority: number;
  enabled: boolean;
}

interface DemoInvitation {
  id: string;
  email: string | null;
  kind: 'link' | 'email';
  status: 'pending' | 'expired';
  expiresAt: string;
  link: string;
}

const access = (store: DemoStore) => store.extra.access as { policies: DemoPolicy[]; invitations: DemoInvitation[] };

function demoApps(store: DemoStore): InviteApp[] {
  return store.stacks
    .filter((s) => s.name !== 'swarmy-system')
    .map((s) => ({ id: s.id, name: s.name, labels: { 'com.docker.stack.namespace': s.name, 'swarmy.env': 'production' } }));
}

export const invitePreview: DomainResolvers = {
  handlers: {
    'policies.simulateInvite': (input, store) => {
      const { role, stackNames = [] } = input as { role: Role; stackNames?: string[] };
      const apps = demoApps(store);
      const names = role === 'member' ? [...new Set(stackNames)] : [];
      const grantedAppIds = names.map((n) => apps.find((a) => a.name === n)?.id ?? n);
      return {
        role,
        stackNames: names,
        appCount: apps.length,
        verdicts: simulateInvite(access(store).policies, { orgId: store.org.id, role, grantedAppIds }, apps),
      };
    },

    'members.resendInvitation': (input, store) => {
      const { id } = input as { id: string };
      const inv = access(store).invitations.find((i) => i.id === id);
      if (!inv) throw new Error(`invitation "${id}" not found`);
      if (inv.kind !== 'email') throw new Error('This invite has no email address to send to. Copy its link instead.');
      // An expired invite comes back with a fresh 7 days (the controller mints a new link).
      if (inv.status === 'expired') Object.assign(inv, { status: 'pending', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
      // The demo has no mail service, like a controller with email switched off.
      return { ...inv, emailed: false };
    },
  },
};
