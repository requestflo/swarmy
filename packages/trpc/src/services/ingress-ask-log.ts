/**
 * The on-demand TLS ask log (board 31: "why didn't my domain get a
 * certificate?"). Before an edge issues a certificate for a host it has
 * never seen, Caddy asks the controller's public `/ingress/ask`; this keeps
 * the latest answers — the host, allowed or refused, and why — in controller
 * memory, bounded. Never the DB: an answer is worth minutes, and the ask is
 * public and high-volume (it is not audited either).
 *
 * One row per (org, host, answer): a repeat moves it to the top and counts
 * it, so a flood of the same refusal can't push the answer someone is
 * looking for out of the log. Org-scoped: an allowed or DNS-pending host
 * belongs to the org that routes it. A host nobody routes belongs to no org
 * — unless the controller serves one org, when it can only be that org's
 * edge asking — and is then shown to nobody.
 */

/** Why the controller answered as it did. */
export type AskWhy = 'routed' | 'dns-pending' | 'unknown' | 'invalid';

export interface AskDecisionInput {
  host: string;
  why: AskWhy;
  /** The org it was answered for; null = no org's (never shown). */
  orgId: string | null;
  /** The app (stack) that routes it, when it is routed. */
  app?: string | null;
}

export interface AskDecisionView {
  host: string;
  allowed: boolean;
  /** The HTTP answer Caddy got: 200 lets it ask the CA, anything else issues nothing. */
  status: 200 | 400 | 403;
  why: AskWhy;
  app: string | null;
  /** The latest answer (ISO) and how many identical answers it stands for. */
  at: string;
  count: number;
}

/** Rows kept across every org. */
export const ASK_LOG_MAX = 300;
/** Rows one org reads. */
export const ASK_LOG_SHOWN = 50;

interface Row extends AskDecisionInput {
  at: number;
  count: number;
}

let rows: Row[] = [];

export const askStatusOf = (why: AskWhy): AskDecisionView['status'] => (why === 'routed' ? 200 : why === 'invalid' ? 400 : 403);

/** Record one answer of `/ingress/ask`. */
export function recordAskDecision(d: AskDecisionInput, at = Date.now()): void {
  const host = d.host.slice(0, 253);
  const same = rows.find((r) => r.orgId === d.orgId && r.host === host && r.why === d.why);
  const count = (same?.count ?? 0) + 1;
  rows = [{ ...d, host, app: d.app ?? null, at, count }, ...rows.filter((r) => r !== same)].slice(0, ASK_LOG_MAX);
}

/** The org's latest answers, newest first. */
export function askDecisions(orgId: string, limit = ASK_LOG_SHOWN): AskDecisionView[] {
  return rows
    .filter((r) => r.orgId === orgId)
    .slice(0, limit)
    .map((r) => ({
      host: r.host,
      allowed: r.why === 'routed',
      status: askStatusOf(r.why),
      why: r.why,
      app: r.app ?? null,
      at: new Date(r.at).toISOString(),
      count: r.count,
    }));
}

/** Test seam. */
export function _resetAskLog(): void {
  rows = [];
}
