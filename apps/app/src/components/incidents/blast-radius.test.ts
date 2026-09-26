import { describe, expect, test } from 'bun:test';
import type { InvService } from '@swarmy/core';
import { blastRadius, holdsData, listWords } from './blast-radius';

function svc(id: string, name: string, stack: string, image: string, status: InvService['status'] = 'running'): InvService {
  return {
    id, name, image, stack, mode: 'replicated', replicas: { desired: 2, running: 2 }, status, scaleToZero: false,
    labels: {}, networks: [], env: [], ports: [], containers: [],
  };
}

const services = [
  svc('web', 'web', 'storefront', 'ghcr.io/northwind/web:1.9.0'),
  svc('co', 'checkout', 'storefront', 'ghcr.io/northwind/checkout:1.1.0', 'degraded'),
  svc('pg', 'postgres', 'data', 'postgres:16-alpine'),
  svc('graf', 'grafana', 'platform', 'grafana/grafana:11'),
  svc('col', 'swarmy-otel-collector', 'swarmy-system', 'otel/collector'),
];
const traffic = { app: 'storefront', requestsPerMin: 586, errors5xxPerMin: 2.3, errorShare: 0.004, hosts: ['api.northwind.dev', 'northwind.shop', 'shop.northwind.dev'] };

describe('blastRadius', () => {
  test('the failing part, its address, the other apps and roughly who saw it', () => {
    const b = blastRadius({ app: 'storefront', part: 'checkout', services, edges: [], traffic, durationSec: 18 * 60 });
    expect(b.failing).toEqual(['checkout']);
    expect(b.address).toBe('northwind.shop');
    expect(b.unaffected).toEqual(['data', 'platform']);
    expect(b.alsoHit).toEqual([]);
    expect(b.noDataLost).toBe(true);
    expect(b.visitors).toBe(41);
  });

  test('an app wired to a failing part is not called unaffected', () => {
    const b = blastRadius({ app: 'storefront', part: 'checkout', services, edges: [{ from: 'co', to: 'pg', kind: 'network' }], traffic, durationSec: 60 });
    expect(b.unaffected).toEqual(['platform']);
    expect(b.alsoHit).toEqual(['data']);
  });

  test('a failing database never reads "no data lost"', () => {
    const withDb = [...services, svc('db', 'storefront_db', 'storefront', 'postgres:16', 'failing')];
    expect(blastRadius({ app: 'storefront', part: null, services: withDb, edges: [], traffic, durationSec: 60 }).noDataLost).toBe(false);
  });

  test('nothing known to be failing says nothing about data', () => {
    const calm = services.map((s) => ({ ...s, status: 'running' as const }));
    expect(blastRadius({ app: 'storefront', part: null, services: calm, edges: [], traffic, durationSec: 60 }).noDataLost).toBe(false);
  });

  test('no traffic data, or no errors, drops the visitor count', () => {
    expect(blastRadius({ app: 'storefront', part: 'checkout', services, edges: [], traffic: undefined, durationSec: 600 }).visitors).toBeNull();
    expect(blastRadius({ app: 'storefront', part: 'checkout', services, edges: [], traffic: { ...traffic, errors5xxPerMin: 0 }, durationSec: 600 }).visitors).toBeNull();
  });
});

describe('helpers', () => {
  test('data parts by image or managed label', () => {
    expect(holdsData({ image: 'postgres:16', labels: {} })).toBe(true);
    expect(holdsData({ image: 'ghcr.io/x/api:1', labels: { 'swarmy.db.cluster': 'main' } })).toBe(true);
    expect(holdsData({ image: 'ghcr.io/x/api:1', labels: {} })).toBe(false);
  });

  test('lists read as a sentence', () => {
    expect(listWords(['data'])).toBe('data');
    expect(listWords(['data', 'platform'])).toBe('data and platform');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
