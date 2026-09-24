import type { StatusTone } from '@swarmy/ui';

/** Human labels for the built-in sign-in providers/methods. */
export const PROVIDER_LABELS: Record<string, string> = {
  microsoft: 'Microsoft',
  github: 'GitHub',
  gitlab: 'GitLab',
  google: 'Google',
  passkey: 'Passkeys',
  magic_link: 'Magic link',
};

export interface ProviderEntry {
  type: string;
  kind: 'social' | 'method';
  enabled: boolean;
  clientId: string | null;
  hasSecret: boolean;
  scopes: string[];
  settings?: Record<string, string>;
  callbackUrl: string;
}

export interface SsoProviderEntry {
  id: string;
  providerId: string;
  protocol: 'oidc' | 'saml';
  domain: string | null;
  issuer: string | null;
  clientId: string | null;
  hasSecret: boolean;
  enabled: boolean;
  metadata: Record<string, unknown>;
  mapping: Record<string, string>;
  callbackUrl: string;
  loginUrl: string;
}

export interface MemberEntry {
  id: string;
  role: string;
  user: { id: string; name: string | null; email: string | null; username?: string | null };
  attributes: Record<string, unknown>;
}

export interface GrantEntry {
  id: string;
  principalType: string;
  principalId: string;
  resourceType: string;
  resourceId: string;
  relation: string;
}

/** On/off state → cluster status tone (tokens only, never raw palette). */
export function enabledTone(enabled: boolean): StatusTone {
  return enabled ? 'online' : 'neutral';
}
