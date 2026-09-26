import type { Tone } from '@/components/calm';
import type { DomainStatus } from '@/components/ingress/domain-state';

export interface Diagnosis {
  tone: Tone;
  /** What's true, in the check's own words where they are already plain. */
  headline: string;
  /** What to do about it (null when there's nothing to do). */
  fix: string | null;
  /** The gate note under it. */
  gate: string | null;
}

/**
 * Turn the check's `reason` + `warnings` (plain sentences from
 * `evaluateDns` / `domainState`) into the diagnosis card: the known cases get
 * a plain fix, anything else is shown as the check said it.
 */
export function diagnose(d: Pick<DomainStatus, 'state' | 'reason' | 'warnings' | 'gated' | 'verifiedAt'>): Diagnosis {
  const r = d.reason;
  const gate =
    d.verifiedAt === null
      ? d.gated
        ? 'Not served yet · swarmy won’t ask for a certificate until DNS points here'
        : 'swarmy won’t ask for a certificate until DNS points here'
      : d.state === 'error'
        ? 'Still served · a verified domain is never taken off the front door'
        : null;
  const base = { gate };
  if (d.state === 'active') {
    const stale = d.warnings.find((w) => w.includes('which is not a swarmy edge'));
    return {
      ...base,
      tone: d.warnings.length ? 'warn' : 'ok',
      headline: r,
      fix: stale ? 'An old record still points somewhere else, so some visitors land there. Delete it at your registrar.' : d.warnings[0] ?? null,
    };
  }
  if (/Cloudflare’s proxy/.test(r)) {
    return { ...base, tone: 'warn', headline: 'It resolves to Cloudflare’s proxy, not your servers.', fix: 'In Cloudflare DNS, click the orange cloud on each record so it turns grey (“DNS only”). swarmy handles HTTPS itself.' };
  }
  if (/An AAAA record points/.test(r)) {
    return { ...base, tone: 'warn', headline: r.split('. ')[0] + '.', fix: 'Let’s Encrypt tries IPv6 first, so it would land somewhere else. Delete the AAAA record, or point it at one of your edges.' };
  }
  if (/^No DNS record for/.test(r)) {
    return { ...base, tone: 'warn', headline: r, fix: 'Add the records below at your registrar. Most publish within a few minutes.' };
  }
  if (/^Still propagating/.test(r)) {
    return { ...base, tone: 'info', headline: 'Almost there: some resolvers still have the old answer cached.', fix: 'Nothing to do. It clears as their cache expires.' };
  }
  if (/ points at .* — expected /.test(r)) {
    return { ...base, tone: 'warn', headline: r.replace(/\.$/, ''), fix: 'Change the record at your registrar to the values below, and delete any parking page or redirect record for the same name.' };
  }
  if (/No ingress node has a known public IP/.test(r)) {
    return { ...base, tone: 'warn', headline: 'None of your servers has a public address yet, so there is nothing to point DNS at.', fix: 'Make a server a front door (Servers → its roles), or set its public address.' };
  }
  if (d.state === 'verified' || d.state === 'issuing') return { ...base, tone: 'info', headline: r, fix: null };
  return { ...base, tone: d.state === 'error' ? 'bad' : 'warn', headline: r, fix: d.warnings[0] ?? null };
}
