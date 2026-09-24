import type { StatusTone } from '@swarmy/ui';

/** Mirrors the controller's `DomainState` (@swarmy/ingress domain-verify). */
export type DomainState = 'waiting_dns' | 'verified' | 'issuing' | 'active' | 'error';

/** Apex ↔ www toggle values (mirrors `WwwMode`). */
export type WwwMode = 'redirect-www-to-apex' | 'redirect-apex-to-www' | 'serve-both';

/** Mirrors the controller's `DomainStatusView` (domain-verify.service.ts). */
export interface DomainStatus {
  host: string;
  state: DomainState;
  reason: string;
  warnings: string[];
  gated: boolean;
  verifiedAt: string | null;
  verifiedManually: boolean;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  dns: { a: string[]; aaaa: string[]; cname: string[]; matched: string[] } | null;
  certificate: {
    issuer: string | null;
    expiresAt: string | null;
    error: string | null;
    edges: Array<{ ip: string; ok: boolean; error?: string }>;
    checkedAt: string | null;
  } | null;
}

export const DOMAIN_STATE_LABEL: Record<DomainState, string> = {
  waiting_dns: 'waiting for DNS',
  verified: 'DNS verified',
  issuing: 'issuing certificate',
  active: 'secured',
  error: 'error',
};

export function domainStateTone(state: DomainState): StatusTone {
  switch (state) {
    case 'active':
      return 'online';
    case 'verified':
    case 'issuing':
      return 'progress';
    case 'waiting_dns':
      return 'warning';
    case 'error':
      return 'offline';
  }
}

export const WWW_LABEL: Record<WwwMode | 'none', string> = {
  none: 'Only this host',
  'redirect-www-to-apex': 'Also www — redirect www → apex',
  'redirect-apex-to-www': 'Also www — redirect apex → www',
  'serve-both': 'Also www — serve both',
};

/** Can this host pair with a www companion? (not wildcards / IPs / single labels) */
export function canPairWww(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h.includes('.') || h.startsWith('*.') || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false;
  return !h.startsWith('www.') || h.slice(4).includes('.');
}
