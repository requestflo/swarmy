/**
 * Mesh link facts in plain words (boards 12, 14, 22), pure. A link is
 * `mesh.links`' row: each end's own view (`ab` = what `a` says about its link
 * to `b`), null when that end's agent didn't report it. Absent is "not
 * reported", never a zero.
 */
import { fmtBytes } from '@/components/buckets/format';

/** Mirror of `MeshLinkEndView` (@swarmy/core/protocol mesh-link.ts). */
export interface LinkEndLike {
  latencyMs: number | null;
  relayed: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
}

/** Mirror of `MeshLinkView`. */
export interface MeshLinkLike {
  a: string;
  b: string;
  ab: LinkEndLike | null;
  ba: LinkEndLike | null;
}

export const pairKey = (x: string, y: string): string => (x < y ? `${x}~${y}` : `${y}~${x}`);

/** "0.4 ms", "4.2 ms", "11 ms"; under 0.1 ms reads "<0.1 ms". */
export function fmtMs(ms: number): string {
  if (ms < 0.1) return '<0.1 ms';
  if (ms < 10) return `${ms.toFixed(1).replace(/\.0$/, '')} ms`;
  return `${Math.round(ms)} ms`;
}

const ends = (l: MeshLinkLike): LinkEndLike[] => [l.ab, l.ba].filter((e): e is LinkEndLike => e !== null);

/** "11 ms", or "11–12 ms" when the two ends measure differently; null when neither measured. */
export function latencyWords(l: MeshLinkLike): string | null {
  const ms = ends(l).flatMap((e) => (e.latencyMs === null ? [] : [e.latencyMs]));
  if (!ms.length) return null;
  const lo = fmtMs(Math.min(...ms));
  const hi = fmtMs(Math.max(...ms));
  return lo === hi ? lo : `${lo.replace(/ ms$/, '')}–${hi}`;
}

/** The lower of the two ends' round trips, for "nearest" picks; null when neither measured. */
export function bestLatency(l: MeshLinkLike): number | null {
  const ms = ends(l).flatMap((e) => (e.latencyMs === null ? [] : [e.latencyMs]));
  return ms.length ? Math.min(...ms) : null;
}

/** Relayed when either end says so, direct when an end says peer to peer; null = neither knows. */
export function linkPath(l: MeshLinkLike): 'relayed' | 'direct' | null {
  const known = ends(l).flatMap((e) => (e.relayed === null ? [] : [e.relayed]));
  if (!known.length) return null;
  return known.some(Boolean) ? 'relayed' : 'direct';
}

/** The words on a link on the mesh map: "0.4 ms", "through the relay · 19 ms"; null = nothing to say. */
export function mapLabel(l: MeshLinkLike): string | null {
  const lat = latencyWords(l);
  if (linkPath(l) === 'relayed') return lat ? `through the relay · ${lat}` : 'through the relay';
  return lat;
}

/** The words on a link on the estate map (board 22): "direct · 11 ms", "relayed · 19 ms". */
export function estateLabel(l: MeshLinkLike): string | null {
  const lat = latencyWords(l);
  const path = linkPath(l);
  if (!lat) return path === 'relayed' ? 'relayed' : null;
  return path ? `${path} · ${lat}` : lat;
}

/** One end as a tech line: "0.4 ms · direct · ↓ 1.2 GB ↑ 340.0 MB", or "not reported". */
export function endWords(e: LinkEndLike | null): string {
  if (!e) return 'not reported';
  const parts = [
    e.latencyMs === null ? null : fmtMs(e.latencyMs),
    e.relayed === null ? null : e.relayed ? 'relayed' : 'direct',
    e.rxBytes === null && e.txBytes === null ? null : `↓ ${fmtBytes(e.rxBytes)} ↑ ${fmtBytes(e.txBytes)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'reported, nothing measured yet';
}

/**
 * A new server's best link (board 12, "direct to home-lab · 0.4 ms"): the
 * lowest round trip among its reported links, else any link whose path is
 * known; null when none is reported.
 */
export function nearestLink(
  links: readonly MeshLinkLike[],
  nodeId: string,
): { other: string; path: 'relayed' | 'direct' | null; latency: string | null } | null {
  const mine = links.filter((l) => (l.a === nodeId || l.b === nodeId) && (bestLatency(l) !== null || linkPath(l) !== null));
  if (!mine.length) return null;
  const best = [...mine].sort((x, y) => (bestLatency(x) ?? Infinity) - (bestLatency(y) ?? Infinity))[0]!;
  const ms = bestLatency(best);
  return { other: best.a === nodeId ? best.b : best.a, path: linkPath(best), latency: ms === null ? null : fmtMs(ms) };
}
