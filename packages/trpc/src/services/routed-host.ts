import { companionHost, normalizeHostname } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { listRoutesForOrg } from './ingress-routes';

/** A routed host (or its www companion), normalised; NOT_FOUND otherwise. */
export function requireRoutedHost(ctx: OrgContext, raw: string): string {
  const host = normalizeHostname(raw);
  const routed = listRoutesForOrg(ctx).some((r) => {
    const h = normalizeHostname(r.route.host);
    return h === host || (Boolean(r.route.www) && companionHost(h) === host);
  });
  if (!routed) throw notFound('domain', host);
  return host;
}
