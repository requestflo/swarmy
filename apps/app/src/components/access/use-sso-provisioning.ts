import * as React from 'react';
import type { SsoProviderEntry } from './access-shared';

export interface SsoProvisioning {
  displayName: string;
  autoProvision: boolean;
  defaultRole: 'member' | 'admin';
  groupsClaim: string;
  /** "idp-group = swarmy-group" lines. */
  groupMapText: string;
}

function parseGroupMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [k, v] = line.split('=').map((s) => s?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Sign-in behaviour of an org SSO provider: login-button label, auto-provision
 * on first login, the role new people get, and how IdP groups become swarmy
 * groups (ABAC policies match on them). Returns the metadata/mapping patch to
 * merge into the provider on save.
 */
export function useSsoProvisioning(p: SsoProviderEntry): {
  value: SsoProvisioning;
  set: (patch: Partial<SsoProvisioning>) => void;
  toPatch: () => { metadata: Record<string, unknown>; mapping: Record<string, string> };
} {
  const m = p.metadata ?? {};
  const [value, setValue] = React.useState<SsoProvisioning>({
    displayName: typeof m.displayName === 'string' ? m.displayName : '',
    autoProvision: m.autoProvision !== false,
    defaultRole: m.defaultRole === 'admin' ? 'admin' : 'member',
    groupsClaim: p.mapping?.groups ?? '',
    groupMapText: Object.entries((m.groupMap as Record<string, string>) ?? {})
      .map(([k, v]) => `${k} = ${v}`)
      .join('\n'),
  });
  const set = (patch: Partial<SsoProvisioning>): void => setValue((v) => ({ ...v, ...patch }));
  const toPatch = () => {
    const mapping = { ...(p.mapping ?? {}) };
    if (value.groupsClaim.trim()) mapping.groups = value.groupsClaim.trim();
    else delete mapping.groups;
    return {
      metadata: {
        displayName: value.displayName.trim() || undefined,
        autoProvision: value.autoProvision,
        defaultRole: value.defaultRole,
        groupMap: parseGroupMap(value.groupMapText),
      },
      mapping,
    };
  };
  return { value, set, toPatch };
}
