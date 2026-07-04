/** In-memory counters surfaced via the admin `/v1/status` endpoint. */
export interface DnsMetrics {
  queries: number;
  byRcode: Record<string, number>;
  steered: number;
  degraded: number;
  truncated: number;
  parseErrors: number;
  lastQueryAt: string | undefined;
}

export function createMetrics(): DnsMetrics {
  return {
    queries: 0,
    byRcode: {},
    steered: 0,
    degraded: 0,
    truncated: 0,
    parseErrors: 0,
    lastQueryAt: undefined,
  };
}

export function recordQuery(
  metrics: DnsMetrics,
  rcode: string,
  flags: { steered: boolean; degraded: boolean },
): void {
  metrics.queries += 1;
  metrics.byRcode[rcode] = (metrics.byRcode[rcode] ?? 0) + 1;
  if (flags.steered) metrics.steered += 1;
  if (flags.degraded) metrics.degraded += 1;
  metrics.lastQueryAt = new Date().toISOString();
}
