import { describe, expect, it } from 'bun:test';
import {
  type CandidateImage,
  type ScanFact,
  decideImageAdmission,
  digestOf,
  extractOrgImages,
  readVerifyCache,
} from './admission-images';

const HOST = 'swarmy-registry:5000';

function img(image: string, service = 'api'): CandidateImage {
  return { service, image, digest: digestOf(image) };
}

describe('extractOrgImages', () => {
  it('keeps only org-registry images and dedupes', () => {
    const specs = [
      { name: 'api', image: `${HOST}/northwind-api@sha256:aaa` },
      { name: 'api-2', image: `${HOST}/northwind-api@sha256:aaa` }, // dupe ref
      { name: 'web', image: 'docker.io/library/nginx:1.27' }, // third-party
      { name: 'db', image: 'postgres:16' },
      { name: 'weird' }, // no image
    ];
    const out = extractOrgImages(specs, HOST);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      service: 'api',
      image: `${HOST}/northwind-api@sha256:aaa`,
      digest: 'sha256:aaa',
    });
  });

  it('returns empty for empty/no-op specs', () => {
    expect(extractOrgImages([], HOST)).toEqual([]);
    expect(extractOrgImages([{ image: 'nginx:1' }], HOST)).toEqual([]);
  });
});

describe('digestOf', () => {
  it('extracts a pinned digest', () => {
    expect(digestOf(`${HOST}/app@sha256:beef`)).toBe('sha256:beef');
  });
  it('returns null for tagged refs', () => {
    expect(digestOf(`${HOST}/app:main`)).toBeNull();
  });
});

describe('decideImageAdmission — blockCriticalCves', () => {
  const policy = { requireSignedImages: false, blockCriticalCves: true };

  it('passes a clean scanned image', () => {
    const v = decideImageAdmission({
      policy,
      images: [img(`${HOST}/app@sha256:a`)],
      scanFor: (): ScanFact => ({ status: 'passed', criticalCount: 0 }),
      signatureFor: () => null,
    });
    expect(v).toEqual([]);
  });

  it('blocks when the latest scan found criticals', () => {
    const v = decideImageAdmission({
      policy,
      images: [img(`${HOST}/app@sha256:a`)],
      scanFor: (): ScanFact => ({ status: 'passed', criticalCount: 2 }),
      signatureFor: () => null,
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'images/critical-cves', severity: 'block', resource: 'api' });
    expect(v[0]?.message).toContain('2 critical CVEs');
  });

  it('warns (not blocks) when the image was never scanned', () => {
    const v = decideImageAdmission({
      policy,
      images: [img(`${HOST}/app:main`)],
      scanFor: () => null,
      signatureFor: () => null,
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'images/unscanned', severity: 'warn' });
  });

  it('warns when the only scan errored (no usable data)', () => {
    const v = decideImageAdmission({
      policy,
      images: [img(`${HOST}/app:main`)],
      scanFor: (): ScanFact => ({ status: 'error', criticalCount: 0 }),
      signatureFor: () => null,
    });
    expect(v[0]).toMatchObject({ rule: 'images/unscanned', severity: 'warn' });
  });
});

describe('decideImageAdmission — requireSignedImages', () => {
  const policy = { requireSignedImages: true, blockCriticalCves: false };

  it('passes a verified image', () => {
    const v = decideImageAdmission({
      policy,
      images: [img(`${HOST}/app@sha256:a`)],
      scanFor: () => null,
      signatureFor: () => true,
    });
    expect(v).toEqual([]);
  });

  it('blocks a definitively unsigned image', () => {
    const v = decideImageAdmission({
      policy,
      images: [img(`${HOST}/app@sha256:a`)],
      scanFor: () => null,
      signatureFor: () => false,
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'images/unsigned', severity: 'block' });
    expect(v[0]?.message).toContain('not signed');
  });

  it('fails closed (blocks) when verification could not run', () => {
    const v = decideImageAdmission({
      policy,
      images: [img(`${HOST}/app@sha256:a`)],
      scanFor: () => null,
      signatureFor: () => null,
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'images/unsigned', severity: 'block' });
    expect(v[0]?.message).toContain('failing closed');
  });
});

describe('decideImageAdmission — combined policy', () => {
  it('stacks scan + signature violations per image', () => {
    const v = decideImageAdmission({
      policy: { requireSignedImages: true, blockCriticalCves: true },
      images: [img(`${HOST}/app@sha256:a`, 'api'), img(`${HOST}/web@sha256:b`, 'web')],
      scanFor: (i): ScanFact | null =>
        i.service === 'api' ? { status: 'passed', criticalCount: 1 } : null,
      signatureFor: (i) => (i.service === 'api' ? true : false),
    });
    expect(v.map((x) => `${x.resource}:${x.rule}`).sort()).toEqual([
      'api:images/critical-cves',
      'web:images/unscanned',
      'web:images/unsigned',
    ]);
  });

  it('does nothing when both toggles are off', () => {
    const v = decideImageAdmission({
      policy: { requireSignedImages: false, blockCriticalCves: false },
      images: [img(`${HOST}/app@sha256:a`)],
      scanFor: () => null,
      signatureFor: () => null,
    });
    expect(v).toEqual([]);
  });
});

describe('readVerifyCache — TTL', () => {
  it('returns fresh entries and expires stale ones', () => {
    const cache = new Map<string, { ok: boolean; at: number }>();
    const t0 = 1_000_000;
    cache.set('sha256:a', { ok: true, at: t0 });
    expect(readVerifyCache(cache, 'sha256:a', t0 + 5 * 60_000, 10 * 60_000)).toBe(true);
    expect(readVerifyCache(cache, 'sha256:a', t0 + 11 * 60_000, 10 * 60_000)).toBeUndefined();
    // expired entries are evicted
    expect(cache.has('sha256:a')).toBe(false);
  });

  it('misses unknown digests', () => {
    expect(readVerifyCache(new Map(), 'sha256:zzz', Date.now())).toBeUndefined();
  });
});
