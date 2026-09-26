import type { Tone } from '@/components/calm';
import type { DomainState, DomainStatus, ResolverSeen } from '@/components/ingress/domain-state';

/** The four steps of the rail (board 29). `error` sits on the step that failed. */
export const STEPS = ['Waiting for DNS', 'Verified', 'Issuing certificate', 'Active'] as const;

export interface RailState {
  /** Index of the step in progress (4 = all done). */
  current: number;
  failed: boolean;
}

export function railState(s: Pick<DomainStatus, 'state' | 'verifiedAt' | 'certificate'>): RailState {
  switch (s.state) {
    case 'waiting_dns':
      return { current: 0, failed: false };
    case 'verified':
      return { current: 1, failed: false };
    case 'issuing':
      return { current: 2, failed: false };
    case 'active':
      return { current: 4, failed: false };
    case 'error':
      // Never verified, or DNS moved away → the DNS step; otherwise the certificate step.
      return { current: s.verifiedAt === null ? 0 : s.certificate ? 2 : 0, failed: true };
  }
}

/** The word on the top-bar chip, and its tone. */
export const STATE_CHIP: Record<DomainState, { word: string; tone: Tone }> = {
  waiting_dns: { word: 'waiting for DNS', tone: 'warn' },
  verified: { word: 'verified', tone: 'info' },
  issuing: { word: 'issuing', tone: 'info' },
  active: { word: 'active', tone: 'ok' },
  error: { word: 'needs you', tone: 'bad' },
};

/** Plain names for the resolvers swarmy asks (see `resolverChainLookup`). */
export function resolverName(r: string): { name: string; how: string } {
  if (r === 'system') return { name: 'swarmy’s own resolver', how: 'the controller’s system DNS' };
  if (r === 'swarmy-dns') return { name: 'swarmy’s nameservers', how: 'asked directly' };
  if (r === '1.1.1.1') return { name: 'Cloudflare 1.1.1.1', how: 'over HTTPS' };
  if (r === '8.8.8.8') return { name: 'Google 8.8.8.8', how: 'over HTTPS' };
  return { name: r, how: 'over HTTPS' };
}

/** What one resolver said, in a few words. */
export function resolverAnswer(r: ResolverSeen): string {
  if (r.error) return `no answer (${r.error})`;
  const ips = [...r.a, ...r.aaaa];
  if (ips.length) return ips.join(', ');
  if (r.cname.length) return `CNAME ${r.cname.join(', ')} (no address)`;
  return r.nxdomain ? 'no such name yet' : 'no address record';
}

/** "2 of 3" — resolvers that answered and see an edge, of those that answered. */
export function agreeCount(resolvers: ResolverSeen[]): { seen: number; answered: number } {
  const answered = resolvers.filter((r) => !r.error);
  return { seen: answered.filter((r) => r.matches).length, answered: answered.length };
}

/** "12 s" / "3 min" / "2 h" — a short duration for the check clock. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/** "last checked 12 s ago · next in 18 s" from the real timestamps, ticking against `now`. */
export function checkClock(s: Pick<DomainStatus, 'lastCheckedAt' | 'nextCheckAt'>, now: number): string {
  const last = s.lastCheckedAt ? `last checked ${shortDuration(now - Date.parse(s.lastCheckedAt))} ago` : 'not checked yet';
  if (!s.nextCheckAt) return last;
  const left = Date.parse(s.nextCheckAt) - now;
  return `${last} · ${left > 0 ? `next in ${shortDuration(left)}` : 'next check due now'}`;
}

/**
 * The footer cadence, matching `nextCheckDelay` in @swarmy/ingress: while
 * waiting every 30 s for 10 min, every 2 min to an hour, every 10 min to a
 * day, then hourly; once verified every minute until the certificate lands;
 * then every 10 minutes.
 */
export function cadenceCopy(state: DomainState, verified: boolean): string {
  if (!verified) {
    return 'We check every 30 s for the first 10 minutes, then every 2 minutes, every 10 minutes after an hour, and hourly after a day. You can leave this page; Activity notes when DNS is verified.';
  }
  if (state === 'active') return 'Active domains are re-checked every 10 minutes. A certificate that stops renewing raises an alert.';
  return 'We check every minute until the certificate is on every edge. You can leave this page; a certificate that fails raises an alert.';
}
