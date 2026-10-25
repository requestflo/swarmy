import type { DemoStore, DomainResolvers } from '../types';

/**
 * "Members sign in with SSO only" for the Northwind demo (`security.ssoOnly.*`,
 * shapes from sso-only.service.ts). Ready providers come from the demo's SSO
 * rows (`store.extra.access.sso`); the pilot is an owner on password + 2FA, so
 * turning it on keeps them signed in, as break-glass does on a real controller.
 */

interface DemoSsoRow {
  providerId: string;
  protocol: 'oidc' | 'saml';
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  metadata: Record<string, unknown>;
  saml: { ready: boolean } | null;
}

function ready(store: DemoStore) {
  const rows = ((store.extra.access as { sso?: DemoSsoRow[] } | undefined)?.sso ?? []).filter(
    (p) => p.enabled && (p.protocol === 'saml' ? p.saml?.ready === true : Boolean(p.clientId && p.hasSecret)),
  );
  return rows.map((p) => ({
    providerId: p.providerId,
    protocol: p.protocol,
    displayName: typeof p.metadata.displayName === 'string' && p.metadata.displayName ? p.metadata.displayName : p.providerId,
  }));
}

function view(store: DemoStore) {
  return { on: store.extra.ssoOnly === true, ready: ready(store), keepsYouSignedIn: true };
}

export const ssoOnly: DomainResolvers = {
  handlers: {
    'security.ssoOnly.get': (_input, store) => view(store),
    'security.ssoOnly.set': (input, store) => {
      const { on } = input as { on: boolean };
      if (on && ready(store).length === 0) {
        throw new Error('Set up company sign-in first: no SSO provider of this workspace can sign people in yet.');
      }
      const wasOn = store.extra.ssoOnly === true;
      store.extra.ssoOnly = on;
      // The demo's other people signed in with passwords: turning it on signs two of them out.
      return { ...view(store), signedOut: on && !wasOn ? 2 : 0 };
    },
  },
};

/** Must this demo invite be accepted with SSO (its flag, or the switch)? */
export function demoInviteNeedsSso(store: DemoStore, requireSso: boolean | undefined): boolean {
  return Boolean(requireSso) || store.extra.ssoOnly === true;
}
