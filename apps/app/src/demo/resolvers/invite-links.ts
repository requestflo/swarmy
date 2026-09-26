import type { DemoStore, DomainResolvers } from '../types';

/**
 * Shareable invite links (inviteLinks.* + the swi_ branch of
 * authConfig.invitePreview) for the Northwind demo. Shapes mirror
 * `inviteLinks.service.ts`. Demo tokens are kept in memory so the accept page
 * (`/join/<token>`) works; the real controller only keeps a hash.
 */

type Role = 'member' | 'admin';
type State = 'ok' | 'expired' | 'used' | 'revoked';

interface InviteLinkView {
  id: string;
  prefix: string;
  role: Role;
  stackName: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  state: State;
  createdAt: string;
  createdBy: { id: string; name: string | null } | null;
  hint: string;
}

interface Stored extends InviteLinkView {
  token: string;
  revoked: boolean;
}

/** The token the demo's seeded storefront link carries (try /join/<it>). */
export const DEMO_INVITE_TOKEN = 'swi_5f0c2a91_northwind-storefront-demo';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const host = (): string => window.location.host;
const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

function stateOf(l: Stored, now = Date.now()): State {
  if (l.revoked) return 'revoked';
  if (l.expiresAt && new Date(l.expiresAt).getTime() <= now) return 'expired';
  if (l.maxUses !== null && l.uses >= l.maxUses) return 'used';
  return 'ok';
}

function links(store: DemoStore): Stored[] {
  let l = store.extra.inviteLinks as Stored[] | undefined;
  if (!l) {
    const by = { id: store.user.id, name: store.user.name };
    const make = (token: string, role: Role, stackName: string | null, uses: number, maxUses: number | null, expiresIn: number | null, madeAgo: number): Stored => {
      const prefix = token.split('_')[1] ?? hex(8);
      return {
        id: `il-${prefix}`,
        prefix,
        token,
        role,
        stackName,
        uses,
        maxUses,
        expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn).toISOString(),
        createdAt: new Date(Date.now() - madeAgo).toISOString(),
        createdBy: by,
        revoked: false,
        state: 'ok',
        hint: `${host()}/join/swi_${prefix}_…`,
      };
    };
    l = [
      make(DEMO_INVITE_TOKEN, 'member', 'storefront', 3, 10, 5 * DAY, 2 * DAY),
      make(`swi_${hex(8)}_x`, 'member', null, 0, 1, 23 * HOUR, HOUR),
    ];
    store.extra.inviteLinks = l;
  }
  return l;
}

const view = (l: Stored): InviteLinkView => {
  const { token: _t, revoked: _r, ...rest } = l;
  return { ...rest, state: stateOf(l) };
};

/** authConfig.invitePreview for a swi_ token (null when unknown or revoked). */
export function inviteLinkPreviewFor(store: DemoStore, token: string) {
  const l = links(store).find((x) => x.token === token);
  if (!l || l.revoked) return null;
  const state = stateOf(l);
  return { orgName: store.org.name, role: l.role, email: null, expired: state !== 'ok', stackName: l.stackName, state };
}

const EXPIRY_DAYS: Record<string, number | null> = { '1d': 1, '7d': 7, never: null };

export const inviteLinks: DomainResolvers = {
  handlers: {
    'inviteLinks.list': (_i, store) => links(store).filter((l) => !l.revoked).map(view),

    'inviteLinks.create': (input, store) => {
      const b = input as { role: Role; stackName?: string | null; expiry: string; maxUses: number | null };
      if (b.stackName && b.role === 'admin') throw new Error('an admin link covers every app — pick Member to limit it to one app');
      const prefix = hex(8);
      const token = `swi_${prefix}_${hex(16)}`;
      const days = EXPIRY_DAYS[b.expiry] ?? null;
      const l: Stored = {
        id: `il-${prefix}`,
        prefix,
        token,
        role: b.role,
        stackName: b.stackName ?? null,
        uses: 0,
        maxUses: b.maxUses,
        expiresAt: days === null ? null : new Date(Date.now() + days * DAY).toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: { id: store.user.id, name: store.user.name },
        revoked: false,
        state: 'ok',
        hint: `${host()}/join/swi_${prefix}_…`,
      };
      links(store).unshift(l);
      return { ...view(l), url: `${window.location.origin}/join/${token}` };
    },

    'inviteLinks.revoke': (input, store) => {
      const { id } = input as { id: string };
      const l = links(store).find((x) => x.id === id);
      if (l) l.revoked = true;
      return { id, revoked: true as const };
    },

    'inviteLinks.preview': (input, store) => {
      const token = (input as { token: string }).token;
      const l = links(store).find((x) => x.token === token);
      if (!l) return null;
      return { kind: 'link' as const, orgName: store.org.name, role: l.role, stackName: l.stackName, state: stateOf(l), expiresAt: l.expiresAt };
    },

    // The demo visitor is already Northwind's owner: accepting doesn't burn a use.
    'inviteLinks.accept': (_input, store) => ({ orgId: store.org.id, alreadyMember: true }),
  },
};
