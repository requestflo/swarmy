import type { DemoStore } from '../types';

/**
 * The demo traffic's shape, shared by traffic.now and traffic.series: the
 * Northwind edges (nodes the geo seed marks `swarmy.node.ingress`, read live
 * so geodns.setNodeRegion moves them), each region's rate right now, a daily
 * curve and deterministic noise.
 */

/** Requests/min right now per region (the whole region, split over its edges). */
const REGION_RATE: Record<string, number> = { 'eu-west': 434, 'us-east': 178, 'ap-south': 61 };
const DEFAULT_REGION_RATE = 40;

interface DemoEdgeNode {
  id: string;
  name: string;
  status: string;
  labels?: Record<string, string>;
}

export interface DemoEdge {
  node: DemoEdgeNode;
  region: string | null;
  live: boolean;
}

export function edgesOf(s: DemoStore): DemoEdge[] {
  return (s.nodes as unknown as DemoEdgeNode[])
    .filter((n) => n.labels?.['swarmy.node.ingress'] === 'true')
    .map((node) => ({ node, region: node.labels?.['swarmy.region'] ?? null, live: node.status === 'online' }));
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Deterministic noise in [-1, 1] for a key (FNV-1a → unit float). */
export function noise(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Daily curve: quiet around 04:00 UTC, busiest mid-afternoon; weekends a bit lower. */
export function curve(t: number): number {
  const d = new Date(t);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const day = 0.62 + 0.38 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
  const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.82 : 1;
  return day * weekend;
}

export function regionRate(region: string | null): number {
  return region ? (REGION_RATE[region] ?? DEFAULT_REGION_RATE) : DEFAULT_REGION_RATE;
}

/** One live edge's share of its region's rate right now. */
export function edgeRate(edges: readonly DemoEdge[], e: DemoEdge): number {
  const peers = edges.filter((x) => x.live && x.region === e.region).length;
  return e.live && peers > 0 ? regionRate(e.region) / peers : 0;
}
