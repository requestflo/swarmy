import { describe, expect, test } from 'bun:test';
import { bow, placeLabels, pointOn, quadPath } from './curve-labels';

describe('curve labels', () => {
  test('a bow lifts the middle by a sixth of the span (at most 60) and draws as M … Q …', () => {
    const q = bow({ x: 0, y: 100 }, { x: 300, y: 100 });
    expect(q.c).toEqual({ x: 150, y: 50 });
    expect(quadPath(q)).toBe('M0 100 Q 150 50 300 100');
    expect(pointOn(q, 0.5)).toEqual({ x: 150, y: 75 });
    expect(bow({ x: 0, y: 0 }, { x: 900, y: 0 }).c.y).toBe(-60);
  });

  test('the middle when clear; further along when a card is in the way; dropped when nothing is clear', () => {
    const curve = bow({ x: 0, y: 100 }, { x: 300, y: 100 });
    const o = { charW: 6, h: 16, width: 400 };
    expect(placeLabels([{ id: 'x', text: '0.4 ms', curve }], [], o)).toEqual([{ id: 'x', text: '0.4 ms', x: 127, y: 67, w: 46, h: 16 }]);
    const moved = placeLabels([{ id: 'x', text: '0.4 ms', curve }], [{ x: 120, y: 60, w: 60, h: 30 }], o);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.x + moved[0]!.w <= 120 || moved[0]!.x >= 180).toBe(true);
    expect(placeLabels([{ id: 'x', text: '0.4 ms', curve }], [{ x: 0, y: 0, w: 400, h: 200 }], o)).toEqual([]);
  });

  test('labels never overprint each other or leave the canvas', () => {
    const curve = bow({ x: 0, y: 100 }, { x: 300, y: 100 });
    const two = placeLabels(
      [
        { id: 'a', text: '11 ms', curve },
        { id: 'b', text: '12 ms', curve },
      ],
      [],
      { charW: 6, h: 16, width: 400 },
    );
    expect(two).toHaveLength(2);
    expect(two[0]!.x + two[0]!.w <= two[1]!.x || two[1]!.x + two[1]!.w <= two[0]!.x).toBe(true);
    const edge = placeLabels([{ id: 'e', text: 'through the relay · 19 ms', curve: bow({ x: 0, y: 10 }, { x: 20, y: 10 }) }], [], { charW: 6, h: 16, width: 400 });
    expect(edge).toEqual([]);
  });
});
