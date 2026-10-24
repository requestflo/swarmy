import { describe, expect, it } from 'bun:test';
import { bucketEndpoints } from './bucket-access.service';
import { buildAttachEnv } from './buckets.service';
import { presignTarget, publicS3Origin } from './public-s3';
import { presignS3Url } from './s3-presign';

/** The org's public S3 endpoint and where presigned URLs are signed for. */

describe('publicS3Origin', () => {
  it('the public hostname becomes an HTTPS origin (the edges serve TLS only)', () => {
    expect(publicS3Origin('s3.northwind.dev')).toBe('https://s3.northwind.dev');
    expect(publicS3Origin(' s3.10-0-0-1.sslip.io ')).toBe('https://s3.10-0-0-1.sslip.io');
  });

  it('no hostname, no endpoint', () => {
    for (const d of [null, undefined, '', '  ']) expect(publicS3Origin(d)).toBeNull();
  });
});

describe('presignTarget — sign for where the link will be opened', () => {
  const endpoints = (mode: 'INTERNAL' | 'MESH' | 'PUBLIC') =>
    bucketEndpoints({ bucket: 'media', mode, publicDomain: 's3.northwind.dev', edgeMeshIps: ['100.71.7.10', '100.71.28.18'] });

  it('a Public bucket signs for the public S3 endpoint', () => {
    expect(presignTarget(endpoints('PUBLIC'))).toEqual({ endpoint: 'https://s3.northwind.dev', reachableFrom: 'internet' });
  });

  it('a private-network bucket signs for the first mesh edge (origin only, no bucket path)', () => {
    expect(presignTarget(endpoints('MESH'))).toEqual({ endpoint: 'http://100.71.28.18:3900', reachableFrom: 'mesh' });
  });

  it('an internal bucket keeps the in-swarm default and says so', () => {
    expect(presignTarget(endpoints('INTERNAL'))).toEqual({ endpoint: undefined, reachableFrom: 'cluster' });
  });

  it('the signed URL carries the public host, so a browser can open it', () => {
    const { endpoint } = presignTarget(endpoints('PUBLIC'));
    const url = presignS3Url({
      endpoint: endpoint!,
      region: 'swarmy',
      bucket: 'media',
      key: 'avatars/u1.png',
      accessKeyId: 'GKpresign',
      secretAccessKey: 'sekrit',
      method: 'PUT',
      expiresSeconds: 900,
      now: new Date('2026-10-24T00:00:00Z'),
    });
    expect(url.startsWith('https://s3.northwind.dev/media/avatars/u1.png?X-Amz-Algorithm=')).toBe(true);
    expect(url).not.toContain('swarmy-garage');
  });
});

describe('S3_PUBLIC_ENDPOINT for attached apps', () => {
  const base = { endpoint: 'http://swarmy-garage:3900', region: 'swarmy', bucket: 'media', accessKeyId: 'GK1', secretName: 's' };

  it('apps get the public endpoint to sign browser links with, beside the in-swarm one they talk to', () => {
    const env = buildAttachEnv({ ...base, publicEndpoint: 'https://s3.northwind.dev' });
    expect(env.S3_PUBLIC_ENDPOINT).toBe('https://s3.northwind.dev');
    expect(env.S3_ENDPOINT).toBe('http://swarmy-garage:3900');
  });

  it('no public endpoint known: the variable is left out, not set empty', () => {
    expect('S3_PUBLIC_ENDPOINT' in buildAttachEnv(base)).toBe(false);
    expect('S3_PUBLIC_ENDPOINT' in buildAttachEnv({ ...base, publicEndpoint: null })).toBe(false);
  });
});
