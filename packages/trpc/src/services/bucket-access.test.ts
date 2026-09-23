import { describe, expect, it } from 'bun:test';
import {
  bucketEndpoints,
  buildObjectStorageEdge,
  derivePublicS3Domain,
  normalizePublicS3Domain,
} from './bucket-access.service';

describe('derivePublicS3Domain', () => {
  it('swarmy.<x> → s3.<x> (the installer sslip domain keeps resolving)', () => {
    expect(derivePublicS3Domain('swarmy.178-128-40-123.sslip.io')).toBe('s3.178-128-40-123.sslip.io');
  });
  it('any other dashboard domain gets an s3. prefix; none without one', () => {
    expect(derivePublicS3Domain('ops.example.com')).toBe('s3.ops.example.com');
    expect(derivePublicS3Domain(undefined)).toBeUndefined();
    expect(derivePublicS3Domain('  ')).toBeUndefined();
  });
});

describe('normalizePublicS3Domain', () => {
  it('lowercases, trims, drops a trailing dot; null/empty clears', () => {
    expect(normalizePublicS3Domain(' S3.Example.COM. ')).toBe('s3.example.com');
    expect(normalizePublicS3Domain(null)).toBeNull();
    expect(normalizePublicS3Domain('')).toBeNull();
  });
  it('refuses anything that is not a hostname (no ports, paths, spaces, wildcards)', () => {
    for (const bad of ['s3.example.com:443', 'https://s3.example.com', 's3 example.com', '*.example.com', 'localhost']) {
      expect(() => normalizePublicS3Domain(bad)).toThrow();
    }
  });
});

describe('buildObjectStorageEdge', () => {
  it('nothing exposed → no edge input at all (no site, no port)', () => {
    expect(buildObjectStorageEdge({ rows: [], publicDomain: 's3.x.io' })).toBeUndefined();
    expect(buildObjectStorageEdge({ rows: [{ bucketName: 'a', mode: 'INTERNAL' }], publicDomain: 's3.x.io' })).toBeUndefined();
  });
  it('splits PUBLIC and MESH, sorted, pointing at Garage on the overlay', () => {
    const e = buildObjectStorageEdge({
      rows: [
        { bucketName: 'zeta', mode: 'PUBLIC' },
        { bucketName: 'alpha', mode: 'MESH' },
        { bucketName: 'beta', mode: 'PUBLIC' },
        { bucketName: 'secret', mode: 'INTERNAL' },
      ],
      publicDomain: 's3.x.io',
    })!;
    expect(e.publicBuckets).toEqual(['beta', 'zeta']);
    expect(e.meshBuckets).toEqual(['alpha']);
    expect(e.upstream).toBe('swarmy-garage:3900');
    expect(JSON.stringify(e)).not.toContain('secret');
  });
});

describe('bucketEndpoints', () => {
  const base = { bucket: 'media', publicDomain: 's3.x.io', edgeMeshIps: ['100.71.7.10', '100.71.52.228'] };
  it('INTERNAL: in-cluster only', () => {
    expect(bucketEndpoints({ ...base, mode: 'INTERNAL' })).toEqual({
      internal: 'http://swarmy-garage:3900/media',
      mesh: [],
      public: null,
    });
  });
  it('MESH: every edge mesh IP on :3900, no public URL', () => {
    const e = bucketEndpoints({ ...base, mode: 'MESH' });
    expect(e.mesh).toEqual(['http://100.71.52.228:3900/media', 'http://100.71.7.10:3900/media']);
    expect(e.public).toBeNull();
  });
  it('PUBLIC: https on the public domain, and the mesh too', () => {
    const e = bucketEndpoints({ ...base, mode: 'PUBLIC' });
    expect(e.public).toBe('https://s3.x.io/media');
    expect(e.mesh).toHaveLength(2);
  });
});
