import { haversineKm, regionCoord, type LatLon } from '@swarmy/dns/steer';
import type { Tone } from '@/components/calm';

/**
 * "Ask from anywhere" (board 32): the places a visitor can ask from are the
 * continent labels swarmy-dns itself can place (`regionCoord`'s continent
 * fallback), so `geodns.previewResolution` steers from the same point this map
 * draws and the km below are the distances the engine ranked by.
 */
export const ASK_FROM = [
  { id: 'us', label: 'North America', pin: { lat: 24, lon: -132 } },
  { id: 'sa', label: 'South America', pin: { lat: -14.2, lon: -51.9 } },
  { id: 'eu', label: 'Europe', pin: { lat: 56, lon: -28 } },
  { id: 'af', label: 'Africa', pin: { lat: -8.8, lon: 24 } },
  { id: 'me', label: 'Middle East', pin: { lat: 34, lon: 42 } },
  { id: 'ap', label: 'Asia', pin: { lat: 40, lon: 100 } },
] as const;
// `pin` is only where the button sits (clear of the edge markers); the visitor
// is drawn — and the engine measures — from `regionCoord(id)`.
export type AskFrom = (typeof ASK_FROM)[number]['id'];

/** The shared world map's frame (resolver-map.tsx): 960×480 equirectangular, cropped to y 36…408. */
export const MAP = { w: 960, h: 480, y: 36, viewH: 372 } as const;

/** A point on that map — the same equirectangular fit d3 gives resolver-map. */
export function mapXY(c: LatLon): { x: number; y: number } {
  return { x: ((c.lon + 180) / 360) * MAP.w, y: ((90 - c.lat) / 180) * MAP.h };
}

/** Where a point sits in the cropped view, as CSS percentages (for buttons over the SVG). */
export function mapPct(c: LatLon): { left: number; top: number } {
  const { x, y } = mapXY(c);
  return { left: (x / MAP.w) * 100, top: ((y - MAP.y) / MAP.viewH) * 100 };
}

/** A gentle arc from the visitor to the edge that answered (quadratic, bowed upwards). */
export function arcPath(a: LatLon, b: LatLon): string {
  const p = mapXY(a);
  const q = mapXY(b);
  const mx = (p.x + q.x) / 2;
  const my = Math.min(p.y, q.y) - 30 - Math.abs(p.x - q.x) / 6;
  return `M${p.x.toFixed(1)} ${p.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
}

/** One answering front door: its region, public IP, health and the server's name. */
export interface AskEndpoint {
  region: string;
  ip: string;
  healthy: boolean;
  name: string;
}

/** `geodns.previewResolution`'s answer. */
export interface AskPreview {
  answers: Array<{ type: string; value: string; ttl: number }>;
  rcode: string;
  steered: boolean;
  degraded: boolean;
}

export interface AskAnswer {
  edge: AskEndpoint | null;
  km: number | null;
  ttl: number | null;
  /** The other answers, in the order a visitor would fall back to them. */
  also: string[];
  word: string;
  tone: Tone;
  why: string;
}

function km(from: string, to: string): number | null {
  const a = regionCoord(from);
  const b = regionCoord(to);
  return a && b ? Math.round(haversineKm(a, b)) : null;
}

/** swarmy-dns's answer for a visitor in `from`, in words. Never invents an edge it didn't answer with. */
export function askAnswer(from: AskFrom, p: AskPreview, endpoints: AskEndpoint[]): AskAnswer {
  const byIp = (ip: string): AskEndpoint | undefined => endpoints.find((e) => e.ip === ip);
  const first = p.answers[0];
  if (!first || p.rcode !== 'NOERROR') {
    const why = p.rcode === 'NXDOMAIN' ? 'There is no such name in this zone.' : 'swarmy-dns gave no address for this name.';
    return { edge: null, km: null, ttl: null, also: [], word: 'no answer', tone: 'bad', why };
  }
  const edge = byIp(first.value) ?? null;
  const also = p.answers.slice(1).map((a) => byIp(a.value)?.name ?? a.value);
  const base = { edge, km: edge ? km(from, edge.region) : null, ttl: first.ttl, also };
  const fallback = also.length ? ` ${also.join(' and ')} ${also.length === 1 ? 'is' : 'are'} in the answer too, as the fallback.` : '';
  if (p.degraded) {
    return { ...base, word: 'everyone', tone: 'warn', why: 'No front door is healthy, so swarmy answers with all of them rather than with nothing.' };
  }
  if (!p.steered) {
    return { ...base, word: 'unsteered', tone: 'idle', why: `swarmy couldn’t place this region, so it answered in a fixed order.${fallback}` };
  }
  const nearer = endpoints
    .filter((e) => !e.healthy && e.ip !== edge?.ip)
    .map((e) => ({ e, d: km(from, e.region) }))
    .filter((x) => x.d !== null && base.km !== null && x.d < base.km)
    .sort((a, b) => (a.d ?? 0) - (b.d ?? 0))[0];
  if (nearer) {
    const why = `${nearer.e.name} is nearer but isn’t healthy, so it left the answer. Visitors still holding it move over when their ${first.ttl} s run out.${fallback}`;
    return { ...base, word: 'rerouted', tone: 'warn', why };
  }
  return {
    ...base,
    word: 'nearest',
    tone: 'ok',
    why: `The nearest healthy front door, by distance over the globe. A real visitor is placed by their resolver’s address, or by their own network when the resolver passes it on.${fallback}`,
  };
}
