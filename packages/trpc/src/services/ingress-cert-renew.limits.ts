/**
 * Whether Renew now is offered for a host (board 30), and the per-host
 * ledger behind its rate limit (`@swarmy/ingress` `renewEligibility`: once
 * an hour, three a week, so a renew can never burn the ACME limits).
 *
 * The ledger is the audit log (`ingress.renewCert`, written before anything
 * is dispatched), read once per host per process, plus this process's own
 * asks, so a controller restart never resets the limit. In-flight renews are
 * process memory: two clicks never run two renews.
 */
import { TRPCError } from '@trpc/server';
import { AGENT_CAPABILITY, agentSupports } from '@swarmy/core/protocol';
import { companionHost, normalizeHostname, renewEligibility, type RenewEligibility } from '@swarmy/ingress';
import type { OrgContext } from '../context';
import { ingressConfigRepo, ingressSettingsOf } from './ingress-config.repo';
import { listRoutesForOrg } from './ingress-routes';

export const RENEW_AUDIT_ACTION = 'ingress.renewCert';
const WEEK_MS = 7 * 86_400_000;

const asks = new Map<string, number[]>();
const seeded = new Set<string>();
const running = new Set<string>();
const key = (orgId: string, host: string) => `${orgId}\u0000${host}`;

/** Every ask for this host in the last week (audit log + this process). */
export async function renewAttempts(ctx: OrgContext, host: string, now = Date.now()): Promise<number[]> {
  const k = key(ctx.activeOrgId, host);
  if (!seeded.has(k)) {
    // A failed read is retried on the next ask; this process's own asks still count meanwhile.
    const rows = await Promise.resolve()
      .then(() =>
        ctx.db.auditLog.findMany({
          where: { orgId: ctx.activeOrgId, action: RENEW_AUDIT_ACTION, targetId: host, ts: { gte: new Date(now - WEEK_MS) } },
          select: { ts: true },
        }),
      )
      .catch(() => null);
    if (rows) {
      asks.set(k, [...rows.map((r) => r.ts.getTime()), ...(asks.get(k) ?? [])]);
      seeded.add(k);
    }
  }
  return (asks.get(k) ?? []).filter((t) => now - t < WEEK_MS);
}

/** Count an ask now (before dispatch, so a failed renew still counts). */
export async function recordRenewAsk(ctx: OrgContext, host: string, at = Date.now()): Promise<void> {
  const prior = await renewAttempts(ctx, host, at);
  asks.set(key(ctx.activeOrgId, host), [...prior, at]);
}

/** Run `fn` as this host's one renew; a second ask while it runs is refused (CONFLICT). */
export async function asTheRenew<T>(orgId: string, host: string, fn: () => Promise<T>): Promise<T> {
  const k = key(orgId, host);
  if (running.has(k)) throw new TRPCError({ code: 'CONFLICT', message: 'A renew for it is already running.' });
  running.add(k);
  try {
    return await fn();
  } finally {
    running.delete(k);
  }
}

/** The route's TLS for a routed host (its www companion shares the route's). */
function routeTls(ctx: OrgContext, host: string): 'auto' | 'off' | 'custom' {
  const r = listRoutesForOrg(ctx).find((x) => {
    const h = normalizeHostname(x.route.host);
    return h === host || (Boolean(x.route.www) && companionHost(h) === host);
  })?.route;
  return r?.tls === 'off' ? 'off' : r?.tls === 'manual' ? 'custom' : 'auto';
}

/** Is Renew now offered for this host, given what the edges hold? */
export async function renewEligibilityFor(
  ctx: OrgContext,
  host: string,
  cert: { issuerKey: string; wildcard: string | null } | null,
  holders: readonly string[],
  caaAllows: boolean | null = null,
): Promise<RenewEligibility> {
  const settings = ingressSettingsOf(await ingressConfigRepo.find(ctx, ctx.activeOrgId).catch(() => null));
  const now = Date.now();
  return renewEligibility({
    tls: routeTls(ctx, host),
    store: settings.topology === 'edge-per-node' ? 'shared' : 'local',
    cert,
    agentsReady: holders.length > 0 && holders.every((n) => agentSupports(ctx.hub.agentBuildFor?.(n)?.capabilities, AGENT_CAPABILITY.edgeCertRenew)),
    caaAllows,
    attempts: await renewAttempts(ctx, host, now),
    inFlight: running.has(key(ctx.activeOrgId, host)),
    now,
  });
}

/** Tests only. */
export function forgetRenewLedger(): void {
  asks.clear();
  seeded.clear();
  running.clear();
}
