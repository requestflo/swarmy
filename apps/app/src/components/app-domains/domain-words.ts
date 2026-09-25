import type { Tone } from '@/components/calm';
import type { StackDomain } from '@/components/ingress/stack-domain-row';

/** One domain in plain words: is it answering, over HTTPS, and what guards it. */
export function domainWords(d: StackDomain): { say: string; word: string; tone: Tone } {
  const p = d.protection;
  const guards = [
    p?.rateLimit ? `${p.rateLimit.requests} requests a ${p.rateLimit.windowSeconds === 60 ? 'minute' : `${p.rateLimit.windowSeconds} s`} per visitor` : null,
    p?.blockBots ? 'bots blocked' : null,
    p && (p.ipDeny.length || p.ipAllow.length) ? 'IP rules' : null,
    p?.countryDeny?.length || p?.countryAllow?.length ? 'country rules' : null,
    p?.bodyMaxSize ? `uploads up to ${p.bodyMaxSize}` : null,
  ].filter((x): x is string => x !== null);
  const guarded = guards.length ? ` Protected: ${guards.join(', ')}.` : ' No protections yet.';
  if (!d.serving) return { say: `The front door isn’t serving yet.${guarded}`, word: 'Offline', tone: 'bad' };
  const st = d.status?.state;
  if (st === 'waiting_dns') return { say: `Waiting for the address to point at your servers.${guarded}`, word: 'Needs you', tone: 'warn' };
  if (st === 'issuing') return { say: `Getting its HTTPS certificate now.${guarded}`, word: 'Deploying', tone: 'info' };
  if (st === 'error') return { say: `${d.status?.reason || 'Something is wrong with this address.'}${guarded}`, word: 'Needs you', tone: 'bad' };
  if (d.tls === 'off') return { say: `Plain HTTP, no certificate.${guarded}`, word: 'Online', tone: 'warn' };
  return { say: `HTTPS, the certificate renews itself.${guarded}`, word: 'Online', tone: 'ok' };
}

/** "storefront answers on 3 addresses. api.x is waiting for its address." */
export function domainsHeadline(stack: string, rows: StackDomain[]): { lead: string; trouble: string | null; calm: string } {
  if (rows.length === 0) return { lead: `${stack} has no address yet.`, trouble: null, calm: 'Add one and swarmy sends it traffic over HTTPS.' };
  const bad = rows.map((d) => ({ d, w: domainWords(d) })).find((x) => x.w.tone === 'bad' || x.w.tone === 'warn');
  const https = rows.filter((d) => d.serving && d.tls !== 'off' && (!d.status || d.status.state === 'active')).length;
  return {
    lead: `${stack} answers on ${rows.length} ${rows.length === 1 ? 'address' : 'addresses'}.`,
    trouble: bad ? `${bad.d.host}: ${bad.w.say.split('.')[0]!.toLowerCase()}.` : null,
    calm: https === rows.length ? (rows.length === 1 ? 'It’s on HTTPS.' : 'All on HTTPS.') : `${https} on HTTPS.`,
  };
}
