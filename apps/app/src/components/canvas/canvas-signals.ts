import type { InvService, ServiceMapNodeView, TrafficAppView } from '@swarmy/core';
import { otelServiceName } from '@/components/app-tabs/scaling/series-model';
import { shortOf } from '@/components/connections/connections-model';

/** One part's live traffic, from its own spans (`observability.map`). */
export interface ServiceMetric {
  /** "38 req/s", "12/min". */
  rate: string;
  /** Controls line: "p95 84 ms · 0.4% errors". */
  tech: string;
}

/** The app's front door on the canvas: its first address and the visits through it. */
export interface DomainSpec {
  host: string;
  /** Other addresses the app answers on. */
  more: number;
  https: boolean;
  /** Visits at the edge for the whole app (`traffic.now`), null with no data. */
  rate: string | null;
  /** Service ids the addresses route to. */
  targets: string[];
}

/** Requests a minute → "38 req/s" from one a second up, else "12/min". */
export function rateWords(perMin: number): string {
  if (perMin >= 60) return `${(perMin / 60).toFixed(perMin >= 600 ? 0 : 1)} req/s`;
  if (perMin > 0 && perMin < 1) return '<1/min';
  return `${Math.round(perMin)}/min`;
}

/**
 * Per part (keyed by short name): the map's RED row whose OTel name is the
 * part's `OTEL_SERVICE_NAME`, its swarm name or its compose short name.
 */
export function serviceMetrics(stack: string, services: readonly InvService[], rows: readonly ServiceMapNodeView[]): Map<string, ServiceMetric> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, ServiceMetric>();
  for (const s of services) {
    const short = shortOf(stack, s.name);
    const row = byId.get(otelServiceName(s)) ?? byId.get(s.name) ?? byId.get(short);
    if (!row) continue;
    out.set(short, {
      rate: rateWords(row.callsPerMin),
      tech: `p95 ${Math.round(row.p95Ms)} ms · ${(row.errorRate * 100).toFixed(1)}% errors`,
    });
  }
  return out;
}

interface DomainLike {
  host: string;
  serviceId: string;
  serving: boolean;
  tls: string;
}

/** The first served address leads (HTTPS ones first); the rest count as "+N". */
export function domainSpec(domains: readonly DomainLike[], app: TrafficAppView | undefined): DomainSpec | null {
  if (domains.length === 0) return null;
  const secure = (d: DomainLike): boolean => d.serving && (d.tls === 'auto' || d.tls === 'custom');
  const lead = domains.find(secure) ?? domains.find((d) => d.serving) ?? domains[0]!;
  return {
    host: lead.host,
    more: new Set(domains.map((d) => d.host)).size - 1,
    https: secure(lead),
    rate: app && app.requestsPerMin > 0 ? rateWords(app.requestsPerMin) : null,
    targets: [...new Set(domains.map((d) => d.serviceId))],
  };
}
