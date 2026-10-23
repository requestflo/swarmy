import { describe, expect, test } from 'bun:test';
import { placeOnRings, reachBlocked, reaches, reachSay, reachUrl, ringSpot } from './reach-model';

describe('reaches', () => {
  test('a ring sees the bucket only when the mode is at least that wide', () => {
    expect(reaches('INTERNAL', 'INTERNAL')).toBe(true);
    expect(reaches('INTERNAL', 'MESH')).toBe(false);
    expect(reaches('MESH', 'INTERNAL')).toBe(true);
    expect(reaches('MESH', 'PUBLIC')).toBe(false);
    expect(reaches('PUBLIC', 'PUBLIC')).toBe(true);
  });
});

describe('reachSay', () => {
  test('public says a key is still needed (reachable is not anonymous)', () => {
    expect(reachSay('PUBLIC')).toContain('still needs a key');
    expect(reachSay('MESH')).toContain('never on the internet');
  });
});

describe('reachUrl', () => {
  test('the widest address wins', () => {
    const internal = 'http://swarmy-garage:3900/media';
    expect(reachUrl({ internal, mesh: [], public: null })).toBe(internal);
    expect(reachUrl({ internal, mesh: ['http://100.64.0.2:3900/media'], public: null })).toBe('http://100.64.0.2:3900/media');
    expect(reachUrl({ internal, mesh: ['http://100.64.0.2:3900/media'], public: 'https://s3.example.com/media' })).toBe(
      'https://s3.example.com/media',
    );
  });
});

describe('reachBlocked', () => {
  test('mesh needs the private network; public needs a domain', () => {
    expect(reachBlocked('MESH', { meshAvailable: false, publicDomain: 's3.x' })).toMatch(/private network/);
    expect(reachBlocked('PUBLIC', { meshAvailable: true, publicDomain: null })).toMatch(/public address/);
    expect(reachBlocked('INTERNAL', { meshAvailable: false, publicDomain: null })).toBeNull();
    expect(reachBlocked('PUBLIC', { meshAvailable: true, publicDomain: 's3.x' })).toBeNull();
  });
});

describe('ringSpot', () => {
  test('a chip sits on its ring, inside the diagram', () => {
    for (const ring of ['INTERNAL', 'MESH', 'PUBLIC'] as const) {
      for (let i = 0; i < 4; i++) {
        const { left, top } = ringSpot(ring, i, 4);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThanOrEqual(100);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThanOrEqual(100);
      }
    }
  });
  test('chips keep clear of the label at 12 o’clock', () => {
    for (let i = 0; i < 6; i++) {
      const { left, top } = ringSpot('PUBLIC', i, 6);
      const nearTop = top < 15 && Math.abs(left - 50) < 12;
      expect(nearTop).toBe(false);
    }
  });
});

describe('placeOnRings', () => {
  test('spreads each ring’s items apart', () => {
    const placed = placeOnRings(['a', 'b', 'c'], (x) => (x === 'c' ? 'PUBLIC' : 'INTERNAL'));
    expect(placed.map((p) => p.ring)).toEqual(['INTERNAL', 'INTERNAL', 'PUBLIC']);
    expect(placed[0]!.left === placed[1]!.left && placed[0]!.top === placed[1]!.top).toBe(false);
  });
});
