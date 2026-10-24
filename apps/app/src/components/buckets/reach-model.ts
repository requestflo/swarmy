import type { Tone } from '@/components/calm';

/**
 * Who can reach a bucket, in rings: Internal (inside swarmy) ⊂ Private
 * network ⊂ Public. Mirrors `bucket-access.service.ts` — the edges enforce
 * the mode and every request still needs a key or a signed link.
 */
export type ReachMode = 'INTERNAL' | 'MESH' | 'PUBLIC';

export const REACH_MODES: readonly ReachMode[] = ['INTERNAL', 'MESH', 'PUBLIC'];

export const REACH_LABEL: Record<ReachMode, string> = {
  INTERNAL: 'Internal',
  MESH: 'Private network',
  PUBLIC: 'Public',
};

/** The ring labels on the diagram (Summary words: no "mesh", no "overlay"). */
export const RING_LABELS: Record<ReachMode, string> = {
  PUBLIC: 'THE INTERNET',
  MESH: 'PRIVATE NETWORK',
  INTERNAL: 'INSIDE SWARMY',
};

/** Dot/word tone per ring (public is the one worth noticing). */
export const REACH_TONE: Record<ReachMode, Tone> = { INTERNAL: 'ok', MESH: 'mesh', PUBLIC: 'warn' };

/** swarmy.yaml `access:` value (packages/app-config BUCKET_ACCESS). */
export const REACH_YAML: Record<ReachMode, 'internal' | 'mesh' | 'public'> = {
  INTERNAL: 'internal',
  MESH: 'mesh',
  PUBLIC: 'public',
};

const LEVEL: Record<ReachMode, number> = { INTERNAL: 0, MESH: 1, PUBLIC: 2 };

/** True when a bucket at `mode` is reachable from `ring`. */
export function reaches(mode: ReachMode, ring: ReachMode): boolean {
  return LEVEL[ring] <= LEVEL[mode];
}

/** The plain explanation under the switch. */
export function reachSay(mode: ReachMode): string {
  switch (mode) {
    case 'INTERNAL':
      return 'Only your apps inside swarmy can reach it, each with its own key. Nothing outside your servers sees it.';
    case 'MESH':
      return 'Your apps, plus laptops and servers on your private network, each with a key. It is never on the internet.';
    case 'PUBLIC':
      return 'Also reachable from the internet over HTTPS at its own address. Every request still needs a key or a signed link.';
  }
}

export interface ReachEndpoints {
  internal: string;
  mesh: string[];
  public: string | null;
}

/** The widest address the bucket answers on right now. */
export function reachUrl(e: ReachEndpoints): string {
  return e.public ?? e.mesh[0] ?? e.internal;
}

/** The S3 origin a client outside points at (`--endpoint-url`): the widest address, scheme + host only. */
export function reachOrigin(e: ReachEndpoints | undefined): string {
  return new URL(e ? reachUrl(e) : 'http://swarmy-garage:3900').origin;
}

/** Why a mode can't be picked yet, or null when it can. */
export function reachBlocked(mode: ReachMode, v: { meshAvailable: boolean; publicDomain: string | null }): string | null {
  if (mode === 'MESH' && !v.meshAvailable) return 'Needs the private network and a front door on it.';
  if (mode === 'PUBLIC' && !v.publicDomain) return 'Needs a public address for files first (Controls, on the bucket’s page).';
  return null;
}

/** Ring radius as a share of the diagram's half-width (board: 66 / 124 / 182 of 190). */
export const RING_SHARE: Record<ReachMode, number> = { INTERNAL: 0.35, MESH: 0.66, PUBLIC: 0.96 };

/** Each ring starts a little further round, so chips on neighbouring rings don't line up. */
const RING_START: Record<ReachMode, number> = { INTERNAL: -45, MESH: -35, PUBLIC: -50 };

/**
 * Where the i-th of n chips sits on its ring, as % of the diagram (left/top).
 * Chips spread over the arc that skips the ring's label at 12 o'clock.
 */
export function ringSpot(ring: ReachMode, i: number, n: number): { left: number; top: number } {
  const span = 270;
  const deg = RING_START[ring] + ((i + 0.5) * span) / Math.max(1, n);
  const rad = (deg * Math.PI) / 180;
  const r = RING_SHARE[ring] * 50;
  return { left: round(50 + r * Math.cos(rad)), top: round(50 + r * Math.sin(rad)) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Group items by ring, keeping their order, and give each its spot. */
export function placeOnRings<T>(items: T[], ringOf: (t: T) => ReachMode): Array<{ item: T; ring: ReachMode; left: number; top: number }> {
  const byRing = new Map<ReachMode, T[]>();
  for (const it of items) byRing.set(ringOf(it), [...(byRing.get(ringOf(it)) ?? []), it]);
  return items.map((item) => {
    const ring = ringOf(item);
    const peers = byRing.get(ring) ?? [];
    return { item, ring, ...ringSpot(ring, peers.indexOf(item), peers.length) };
  });
}
