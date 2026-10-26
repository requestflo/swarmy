import { describe, expect, test } from 'bun:test';
import type { LinkEndLike } from '@/components/networking/mesh-link-words';
import type { PlacedCard } from './map-layout';
import { estateCurve, isRelayed, placeEstateLinkLabels, type EstateMeshLink } from './mesh-link-place';

const end = (latencyMs: number | null, relayed: boolean | null): LinkEndLike => ({ latencyMs, relayed, rxBytes: null, txBytes: null });
const card = (id: string, x: number, y: number): PlacedCard => ({ id, x, y, w: 200, h: 120 });
// Two regions far apart, and a second card right under the first (no room between them).
const cards = new Map([
  ['lon-1', card('lon-1', 40, 60)],
  ['lon-2', card('lon-2', 40, 190)],
  ['home', card('home', 640, 80)],
]);

describe('estate map link words (board 22)', () => {
  test('a reported link gets "direct · 11 ms" / "relayed · 19 ms" where it runs clear of the cards', () => {
    const links: EstateMeshLink[] = [
      { a: 'home', b: 'lon-1', ok: true, facts: { a: 'home', b: 'lon-1', ab: end(11, false), ba: end(11.3, false) } },
      { a: 'home', b: 'lon-2', ok: true, facts: { a: 'home', b: 'lon-2', ab: null, ba: end(19, true) } },
      // Not reported: no words.
      { a: 'lon-1', b: 'lon-2', ok: true },
    ];
    const placed = placeEstateLinkLabels(links, cards, { width: 1000 });
    expect(placed.map((p) => [p.id, p.text, p.relayed])).toEqual([
      ['home~lon-1', 'direct · 11 ms', false],
      ['home~lon-2', 'relayed · 19 ms', true],
    ]);
    for (const p of placed) {
      for (const c of cards.values()) expect(p.x + p.w <= c.x - 6 || p.x >= c.x + c.w + 6 || p.y + p.h <= c.y - 6 || p.y >= c.y + c.h + 6).toBe(true);
    }
    expect(isRelayed(links[1]!)).toBe(true);
    expect(isRelayed(links[2]!)).toBe(false);
  });

  test('a link with no clear stretch (stacked cards) and a keep-clear area leave the words off', () => {
    const stacked: EstateMeshLink[] = [{ a: 'lon-1', b: 'lon-2', ok: true, facts: { a: 'lon-1', b: 'lon-2', ab: end(0.4, false), ba: null } }];
    expect(placeEstateLinkLabels(stacked, cards, { width: 1000 })).toEqual([]);
    const far: EstateMeshLink[] = [{ a: 'home', b: 'lon-1', ok: true, facts: { a: 'home', b: 'lon-1', ab: end(11, false), ba: null } }];
    expect(placeEstateLinkLabels(far, cards, { width: 1000, keepClear: [{ x: 0, y: 0, w: 1000, h: 400 }] })).toEqual([]);
  });

  test('the curve runs between card centres with the lens\'s bow', () => {
    const q = estateCurve(cards.get('lon-1')!, cards.get('home')!);
    expect(q.a).toEqual({ x: 140, y: 120 });
    expect(q.b).toEqual({ x: 740, y: 140 });
    expect(q.c).toEqual({ x: 440, y: 50 });
  });
});
