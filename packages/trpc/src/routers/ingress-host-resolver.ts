import { PRODUCTION, resourceEnv } from '@swarmy/abac';
import { companionHost, normalizeHostname } from '@swarmy/ingress';
import { resolveService, type ResolveResource } from '../abac';
import { listRoutesForOrg } from '../services/ingress-routes';

/** `{ host }` — a routed host (or its www companion) → its target service. */
export const resolveDomainHost: ResolveResource = async (ctx, input) => {
  const raw = (input as { host?: unknown } | null)?.host;
  if (typeof raw !== 'string' || !raw) return null;
  const host = normalizeHostname(raw);
  const hits = listRoutesForOrg(ctx).filter((r) => {
    const h = normalizeHostname(r.route.host);
    return h === host || (Boolean(r.route.www) && companionHost(h) === host);
  });
  // A host can be routed by several services (per path): judge it by the most
  // sensitive one — production wins.
  const resources = await Promise.all(hits.map((r) => resolveService(ctx, { id: r.serviceId })));
  const live = resources.filter((r): r is NonNullable<typeof r> => r !== null);
  return live.find((r) => resourceEnv({ labels: r.labels ?? {} }) === PRODUCTION) ?? live[0] ?? null;
};
