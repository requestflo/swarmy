import { TRAFFIC_WINDOWS, TrafficSeriesInput, addLatency, latencyView, type LatencyBuckets, type TrafficSeriesView } from '@swarmy/core';
import type { DemoStore } from '../types';
import { APPS } from './traffic-apps';
import { blockedShare, demoHistogram, medianFor } from './traffic-latency';
import { curve, edgeRate, edgesOf, noise, round1 } from './traffic-shape';

/** The addresses a filter covers, each with its share of all visits. */
function hostsFor(app: string | null | undefined, host: string | undefined): Array<{ host: string; share: number; errorShare: number }> {
  return APPS.filter((a) => app === undefined || a.app === app).flatMap((a) =>
    a.hosts.filter(([h]) => host === undefined || h === host).map(([h, s]) => ({ host: h, share: a.share * s, errorShare: a.errorShare })),
  );
}

/**
 * Sparklines (router `traffic.series`), shaped like traffic-series.ts: an app,
 * region, address or edge over 6h / 24h / 7d. Rates follow the daily curve
 * plus deterministic noise; each point's p50/p95 merges a histogram per
 * (edge, address) — answers slow a little when it's busy — and blocked is
 * each address's 403 + 429 share.
 */
export function trafficSeries(raw: unknown, s: DemoStore): TrafficSeriesView {
  const input = TrafficSeriesInput.parse(raw ?? {});
  const now = Date.now();
  const { spanMs, bucketMs } = TRAFFIC_WINDOWS[input.window];
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - spanMs;
  const host = input.host?.toLowerCase();

  const all = edgesOf(s);
  const live = all.filter((e) => e.live && (!input.region || e.region === input.region) && (!input.nodeId || e.node.id === input.nodeId));
  const hosts = hostsFor(input.app, host);
  const share = hosts.reduce((n, h) => n + h.share, 0);
  const errShare = share > 0 ? hosts.reduce((n, h) => n + h.share * h.errorShare, 0) / share : 0;
  const blocked = share > 0 ? hosts.reduce((n, h) => n + h.share * (blockedShare(h.host)[0] + blockedShare(h.host)[1]), 0) / share : 0;
  const base = live.reduce((n, e) => n + edgeRate(all, e), 0);
  // Scale the curve so the newest point sits at today's "now" rate.
  const anchor = curve(now);
  const key = `${input.app === undefined ? '*' : (input.app ?? 'other')}|${input.region ?? '*'}|${host ?? '*'}|${input.nodeId ?? '*'}`;
  const perMin = bucketMs / 60_000;

  const points = Array.from({ length: spanMs / bucketMs }, (_, i) => {
    const t = start + i * bucketMs;
    if (base === 0) return { t, requestsPerMin: null, errors5xxPerMin: null, p50Ms: null, p95Ms: null, blockedPerMin: null };
    const load = curve(t) / anchor;
    const jitter = 1 + 0.09 * noise(`${key}|${Math.floor(t / bucketMs)}`);
    const rate = Math.max(0, base * share * load * jitter);
    let hist: LatencyBuckets | undefined;
    for (const e of live) {
      for (const h of hosts) {
        const n = edgeRate(all, e) * h.share * load * perMin;
        hist = addLatency(hist, demoHistogram(medianFor(e.region, h.host) * (0.85 + 0.25 * load), n));
      }
    }
    return { t, requestsPerMin: round1(rate), errors5xxPerMin: round1(rate * errShare), ...latencyView(hist), blockedPerMin: round1(rate * blocked) };
  });
  return {
    window: input.window,
    bucketSec: bucketMs / 1000,
    unit: 'requests/min',
    ...(input.app !== undefined ? { app: input.app } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(host ? { host } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    sampledAt: base ? now - 4_000 : null,
    points,
  };
}
