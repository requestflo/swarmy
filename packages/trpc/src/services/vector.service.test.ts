import { describe, expect, it } from 'bun:test';
import {
  encodeVectorStatsLabel,
  parseQdrantCollections,
  parseVectorStatsLabel,
  qdrantSpec,
  vectorDataVolume,
  vectorKeySecretName,
  vectorNetworkName,
  vectorServiceName,
  vectorStatsCommand,
} from './vector.service';

describe('parseQdrantCollections', () => {
  it('parses a qdrant /collections response into a sorted sample', () => {
    const raw = JSON.stringify({
      time: 0.0001,
      status: 'ok',
      result: { collections: [{ name: 'products' }, { name: 'docs' }] },
    });
    expect(parseQdrantCollections(raw)).toEqual({
      collections: 2,
      collectionNames: ['docs', 'products'],
    });
  });

  it('returns an empty sample for zero collections', () => {
    const raw = JSON.stringify({ result: { collections: [] } });
    expect(parseQdrantCollections(raw)).toEqual({ collections: 0, collectionNames: [] });
  });

  it('drops entries without a string name', () => {
    const raw = JSON.stringify({ result: { collections: [{ name: 'a' }, { id: 3 }, null] } });
    expect(parseQdrantCollections(raw)).toEqual({ collections: 1, collectionNames: ['a'] });
  });

  it('returns null for non-qdrant payloads and non-JSON', () => {
    expect(parseQdrantCollections('{"error":"unauthorized"}')).toBeNull();
    expect(parseQdrantCollections('not json')).toBeNull();
    expect(parseQdrantCollections('{"result":{}}')).toBeNull();
  });
});

describe('vector stats label codec', () => {
  it('round-trips a sample', () => {
    const stats = { collections: 2, collectionNames: ['a', 'b'], at: '2026-07-02T00:00:00.000Z' };
    expect(parseVectorStatsLabel(encodeVectorStatsLabel(stats))).toEqual(stats);
  });

  it('caps the encoded name list at 25 (labels are size-limited)', () => {
    const names = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const encoded = encodeVectorStatsLabel({ collections: 40, collectionNames: names, at: 'x' });
    const parsed = parseVectorStatsLabel(encoded);
    expect(parsed?.collections).toBe(40);
    expect(parsed?.collectionNames).toHaveLength(25);
  });

  it('degrades to null on malformed/foreign labels', () => {
    expect(parseVectorStatsLabel(undefined)).toBeNull();
    expect(parseVectorStatsLabel('')).toBeNull();
    expect(parseVectorStatsLabel('{"foo":1}')).toBeNull();
    expect(parseVectorStatsLabel('garbage')).toBeNull();
  });
});

describe('naming', () => {
  it('derives every name from <stack>_<name>', () => {
    expect(vectorServiceName('shop', 'search')).toBe('shop_search-vector');
    expect(vectorNetworkName('shop', 'search')).toBe('shop_search-vector-net');
    expect(vectorDataVolume('shop', 'search')).toBe('shop_search-vector-data');
    expect(vectorKeySecretName('shop', 'search')).toBe('swarmy-vector-shop_search-key');
  });
});

describe('qdrantSpec', () => {
  const spec = qdrantSpec('shop', 'search');

  it('is private-only (no ports) with a single replica', () => {
    expect(spec.ports).toBeUndefined();
    expect(spec.mode).toEqual({ replicated: { replicas: 1 } });
    expect(spec.image).toBe('qdrant/qdrant:v1.12');
  });

  it('carries the swarmy.vector.* labels + scale-to-zero exemption', () => {
    expect(spec.labels?.['swarmy.vector.kind']).toBe('qdrant');
    expect(spec.labels?.['swarmy.vector.name']).toBe('search');
    expect(spec.labels?.['swarmy.managed']).toBe('true');
    expect(spec.labels?.['swarmy.scaleToZero.exempt']).toBe('true');
    expect(spec.labels?.['com.docker.stack.namespace']).toBe('shop');
  });

  it('reads the API key from the mounted secret, never from env/labels', () => {
    expect(spec.env).toBeUndefined();
    expect(spec.secrets).toEqual([
      { source: 'swarmy-vector-shop_search-key', target: 'vector-api-key' },
    ]);
    expect(spec.command).toEqual(['sh', '-c']);
    expect(spec.args?.[0]).toContain('cat /run/secrets/vector-api-key');
    expect(JSON.stringify(spec.labels)).not.toContain('api');
  });

  it('mounts the data volume at /qdrant/storage on the instance network', () => {
    expect(spec.mounts).toEqual([
      { type: 'volume', source: 'shop_search-vector-data', target: '/qdrant/storage' },
    ]);
    expect(spec.networks).toEqual(['shop_search-vector-net']);
  });
});

describe('vectorStatsCommand', () => {
  it('curls localhost with the api-key header from the secret file', () => {
    const cmd = vectorStatsCommand();
    expect(cmd).toContain('http://127.0.0.1:6333/collections');
    expect(cmd).toContain('api-key: $(cat /run/secrets/vector-api-key)');
  });
});
