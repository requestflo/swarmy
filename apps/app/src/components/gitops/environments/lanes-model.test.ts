import { describe, expect, test } from 'bun:test';
import type { InvService } from '@swarmy/core';
import { imageRef, imagesOf, laneServices, promoteChanges } from './lanes-model';

const D = 'sha256:d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5';
const svc = (stack: string, name: string, image: string, copies = 1): InvService =>
  ({ id: `${stack}-${name}`, name: `${stack}_${name}`, stack, image, replicas: { desired: copies, running: copies } }) as InvService;

const live = [
  svc('shop', 'web', 'ghcr.io/x/web:1.8.2', 3),
  svc('shop', 'api', 'ghcr.io/x/api:2.4.0', 2),
  svc('shop-staging', 'web', `ghcr.io/x/web@${D}`),
  svc('shop-staging', 'api', 'ghcr.io/x/api:2.4.0'),
];

describe('lanes', () => {
  test('image refs: a digest, a tag, nothing', () => {
    expect(imageRef(`ghcr.io/x/web@${D}`)).toBe('@d4e5f6a');
    expect(imageRef('localhost:5000/web:2.4.0')).toBe(':2.4.0');
    expect(imageRef('localhost:5000/web')).toBe(':latest');
  });
  test('a lane marks what production runs differently', () => {
    const lane = laneServices('shop-staging', live, imagesOf('shop', live));
    expect(lane.map((s) => `${s.name}${s.differs ? '*' : ''}`)).toEqual(['api', 'web*']);
  });
  test('a promote changes only the digests production does not run yet', () => {
    const r = promoteChanges({ web: `ghcr.io/x/web@${D}`, api: 'ghcr.io/x/api:2.4.0' }, imagesOf('shop', live));
    expect(r.changes.map((c) => c.name)).toEqual(['web']);
    expect(r.same).toEqual(['api']);
  });
});
