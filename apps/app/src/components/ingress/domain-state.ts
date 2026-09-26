import type { StatusTone } from '@swarmy/ui';
import type { DnsGateView, DomainResolverView } from '@swarmy/core';

/** Mirrors the controller's `DomainState` (@swarmy/ingress domain-verify). */
export type DomainState = 'waiting_dns' | 'verified' | 'issuing' | 'active' | 'error';

/** Apex ↔ www toggle values (mirrors `WwwMode`). */
export type WwwMode = 'redirect-www-to-apex' | 'redirect-apex-to-www' | 'serve-both';

/** One resolver's result on the last check (`DomainResolverView`, @swarmy/core). */
export type ResolverView = DomainResolverView;
/** The go-live gate on the last check (`DnsGateView`, @swarmy/core). */
export type DnsGate = DnsGateView;

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
  dns: { a: string[]; aaaa: string[]; cname: string[]; matched: string[]; resolvers: ResolverView[]; gate: DnsGate | null } | null;
  certificate: {
    issuer: string | null;
    expiresAt: string | null;
    error: string | null;
    edges: Array<{ ip: string; ok: boolean; error?: string }>;
    checkedAt: string | null;
  } | null;
}

/** One record to create (mirrors `DnsRecordHint`). */
export interface DnsRecordHint {
  type: 'A' | 'AAAA' | 'CNAME' | 'NS';
  name: string;
  label: string;
  value: string;
  note?: string;
}

/** Mirrors `DnsGuidance`. */
export interface DnsGuidance {
  mode: 'records' | 'zone' | 'tunnel' | 'private';
  summary: string;
  records: DnsRecordHint[];
  alternatives: DnsRecordHint[];
  wildcard?: { provider: 'swarmy' | 'cloudflare' | null; summary: string };
}

/** Mirrors `DomainDetailView` (`ingress.domainStatus`). */
export interface DomainDetail extends DomainStatus {
  guidance: DnsGuidance;
  companion: DomainStatus | null;
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

/** Can this host pair with a www companion? (not wildcards / IPs / single labels) */
export function canPairWww(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h.includes('.') || h.startsWith('*.') || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false;
  return !h.startsWith('www.') || h.slice(4).includes('.');
}

/** Mirrors `DomainPlanView` (`ingress.domainPlan`): the records for a host before it is added. */
export interface DomainPlan {
  host: string;
  apex: string;
  isApex: boolean;
  registrar: DnsGuidance;
  nameserver: { zone: string; nameservers: Array<{ fqdn: string; ip: string }>; guidance: DnsGuidance } | null;
  edges: Array<{ ip: string; name: string | null; region: string | null }>;
}
