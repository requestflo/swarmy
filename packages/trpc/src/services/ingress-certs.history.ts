/**
 * The renewals swarmy has seen per host (board 30, Renewals), in process
 * memory: a later edge read with a newer notBefore than an earlier one is a
 * renewal (`@swarmy/ingress` `noteCert`). Operational observation, not
 * config or audit, so never a DB row or a label; after a controller restart
 * the history starts again from the certificate the edges hold, and the
 * dashboard shows no renewal it did not see.
 */
import { EMPTY_HISTORY, noteCert, type CertHistory, type SeenCert } from '@swarmy/ingress';

const histories = new Map<string, CertHistory>();
const key = (orgId: string, host: string) => `${orgId}\u0000${host}`;

export function certHistory(orgId: string, host: string): CertHistory {
  return histories.get(key(orgId, host)) ?? EMPTY_HISTORY;
}

/** Fold one read of the host's certificate in; returns the updated history. */
export function recordSeenCert(orgId: string, host: string, seen: SeenCert): CertHistory {
  const next = noteCert(certHistory(orgId, host), seen);
  histories.set(key(orgId, host), next);
  return next;
}

/** A Renew now landed: credit the next renewal seen to the request. */
export function markRenewRequested(orgId: string, host: string, at: string): void {
  histories.set(key(orgId, host), { ...certHistory(orgId, host), requestedAt: at });
}

/** Tests only. */
export function forgetCertHistories(): void {
  histories.clear();
}
