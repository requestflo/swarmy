/**
 * Pure: the CAA row of the Certificate card (board 30), from `ingress.caa`:
 * may the front door's certificate authority issue for this address?
 */
import type { inferOutput, TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { AppRouter } from '@swarmy/trpc';
import type { Tone } from '@/components/calm/tone';

export type CaaFacts = inferOutput<TRPCOptionsProxy<AppRouter>['ingress']['caa']>;

/** "letsencrypt.org allowed", with the reason underneath when it is not that simple. */
export function caaLine(v: CaaFacts | null | undefined): { text: string; tone: Tone; note: string | null } | null {
  if (!v) return null;
  switch (v.state) {
    case 'allowed':
      return { text: `${v.ca.caa} allowed`, tone: v.caveats.length ? 'warn' : 'ok', note: v.caveats.length ? `Allowed, but ${v.caveats.join('; ')}.` : null };
    case 'open':
      return { text: `${v.ca.caa} allowed`, tone: 'ok', note: 'No CAA records, so any certificate authority may issue.' };
    case 'forbidden':
      return { text: `${v.ca.name} not allowed`, tone: 'bad', note: v.say };
    case 'unknown':
      return { text: 'could not check', tone: 'warn', note: v.say };
  }
}

/** The Controls line: where the deciding set is, what was asked, the records as written. */
export function caaTech(v: CaaFacts | null | undefined): string | null {
  if (!v) return null;
  const records = v.records.map((r) => `${r.critical} ${r.tag} "${r.value}"`).join(' · ');
  return `CAA ${v.at ? `at ${v.at}` : 'none found'} · asked ${v.asked.join(' → ')}${records ? ` · ${records}` : ''}`;
}
