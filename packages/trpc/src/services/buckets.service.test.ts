import { describe, expect, it } from 'bun:test';
import {
  ATTACH_ENV_KEYS,
  attachKeyName,
  attachSecretName,
  BUCKET_MARKER,
  buildAdminScript,
  buildAttachEnv,
  buildBucketDumpScript,
  buildGrantBody,
  buildQuotaBody,
  buildWebsiteBody,
  garageAdminBase,
  garageS3Endpoint,
  normalizeBucketInfo,
  parseAdminOutput,
  parseBucketDump,
  parseBucketIds,
  rotatedSecretName,
  STATUS_MARKER,
} from './buckets.service';

describe('garage admin request builders', () => {
  it('grant body carries bucketId + accessKeyId + normalized flags', () => {
    const body = JSON.parse(
      buildGrantBody('abc123', 'GK1', { read: true, write: true, owner: false }),
    ) as Record<string, unknown>;
    expect(body).toEqual({
      bucketId: 'abc123',
      accessKeyId: 'GK1',
      permissions: { read: true, write: true, owner: false },
    });
  });

  it('quota body maps view fields to garage names and keeps null = unlimited', () => {
    expect(JSON.parse(buildQuotaBody({ maxSizeBytes: 5_000_000_000, maxObjects: null }))).toEqual({
      quotas: { maxSize: 5_000_000_000, maxObjects: null },
    });
    expect(JSON.parse(buildQuotaBody({ maxSizeBytes: null, maxObjects: 10_000 }))).toEqual({
      quotas: { maxSize: null, maxObjects: 10_000 },
    });
  });

  it('website body defaults index.html on enable and stays minimal on disable', () => {
    expect(JSON.parse(buildWebsiteBody({ enabled: true }))).toEqual({
      websiteAccess: { enabled: true, indexDocument: 'index.html' },
    });
    expect(
      JSON.parse(
        buildWebsiteBody({ enabled: true, indexDocument: 'home.html', errorDocument: '404.html' }),
      ),
    ).toEqual({
      websiteAccess: { enabled: true, indexDocument: 'home.html', errorDocument: '404.html' },
    });
    expect(JSON.parse(buildWebsiteBody({ enabled: false }))).toEqual({
      websiteAccess: { enabled: false },
    });
  });

  it('admin script passes token/body via env only (never argv) and emits the status marker', () => {
    const script = buildAdminScript();
    expect(script).toContain('$GARAGE_ADMIN_TOKEN');
    expect(script).toContain('$GARAGE_URL');
    expect(script).toContain(STATUS_MARKER);
    // the token must not be interpolated into the script itself
    expect(script).not.toContain('Bearer gk');
  });

  it('dump script loops the controller-provided id list', () => {
    const script = buildBucketDumpScript();
    expect(script).toContain('$GARAGE_BUCKET_IDS');
    expect(script).toContain(BUCKET_MARKER);
  });

  it('endpoints are stable strings', () => {
    expect(garageAdminBase()).toBe('http://127.0.0.1:3903/v1');
    expect(garageS3Endpoint()).toBe('http://swarmy-garage:3900');
  });
});

describe('admin output parsing', () => {
  it('splits status marker from body', () => {
    const out = `${STATUS_MARKER}200\n{"id":"b1"}`;
    expect(parseAdminOutput(out)).toEqual({ status: 200, body: '{"id":"b1"}' });
  });

  it('tolerates curl noise before the marker and empty bodies', () => {
    expect(parseAdminOutput(`some tls warning\n${STATUS_MARKER}204\n`)).toEqual({
      status: 204,
      body: '',
    });
    expect(parseAdminOutput('curl: (7) connection refused').status).toBe(0);
  });

  it('extracts bucket ids from the list payload', () => {
    expect(
      parseBucketIds([
        { id: 'aaaa', globalAliases: ['assets'] },
        { id: 'bbbb' },
        { nope: true },
        'garbage',
      ]),
    ).toEqual(['aaaa', 'bbbb']);
    expect(parseBucketIds({ not: 'an array' })).toEqual([]);
  });

  it('splits a bucket dump into per-id payloads', () => {
    const dump = [
      `${BUCKET_MARKER}aaaa`,
      '{"id":"aaaa","bytes":10}',
      `${BUCKET_MARKER}bbbb`,
      '{"id":"bbbb","bytes":20}',
      '',
    ].join('\n');
    const parsed = parseBucketDump(dump);
    expect(parsed.get('aaaa')).toBe('{"id":"aaaa","bytes":10}');
    expect(parsed.get('bbbb')).toBe('{"id":"bbbb","bytes":20}');
    expect(parsed.size).toBe(2);
  });
});

describe('bucket info normalization', () => {
  it('maps a full garage payload to the view shape', () => {
    const view = normalizeBucketInfo({
      id: 'deadbeef',
      globalAliases: ['assets'],
      websiteAccess: true,
      objects: 1234,
      bytes: 9_876_543,
      unfinishedUploads: 2,
      quotas: { maxSize: 1_000_000, maxObjects: null },
      keys: [
        { accessKeyId: 'GK1', name: 'ci', permissions: { read: true, write: true, owner: false } },
        { accessKeyId: 'GK2', name: 'ro', permissions: { read: true } },
      ],
    });
    expect(view.id).toBe('deadbeef');
    expect(view.name).toBe('assets');
    expect(view.usageBytes).toBe(9_876_543);
    expect(view.objects).toBe(1234);
    expect(view.website).toBe(true);
    expect(view.quotas).toEqual({ maxSizeBytes: 1_000_000, maxObjects: null });
    expect(view.keyCount).toBe(2);
    expect(view.keys[1]!.permissions).toEqual({ read: true, write: false, owner: false });
  });

  it('is defensive about missing fields', () => {
    const view = normalizeBucketInfo({ id: 'x' });
    expect(view.name).toBe('x');
    expect(view.usageBytes).toBe(0);
    expect(view.objects).toBe(0);
    expect(view.website).toBe(false);
    expect(view.quotas).toEqual({ maxSizeBytes: null, maxObjects: null });
    expect(view.keys).toEqual([]);
  });
});

describe('attach naming + env', () => {
  it('sanitizes docker secret names and caps at 64 chars', () => {
    expect(attachSecretName('web_api', 'user uploads!')).toBe('swarmy-s3-web_api-user-uploads-');
    expect(attachSecretName('a'.repeat(80), 'b'.repeat(80)).length).toBe(64);
    expect(attachSecretName('shop_web', 'assets')).toMatch(/^[a-zA-Z0-9_.-]+$/);
  });

  it('derives a descriptive garage key name', () => {
    expect(attachKeyName('shop_web', 'assets')).toBe('swarmy-attach-shop_web-assets');
  });

  it('injects the documented S3_* env with the secret as a file ref', () => {
    const env = buildAttachEnv({
      endpoint: 'http://swarmy-garage:3900',
      region: 'swarmy',
      bucket: 'assets',
      accessKeyId: 'GK1',
      secretName: 'swarmy-s3-web-assets',
    });
    expect(env).toEqual({
      S3_ENDPOINT: 'http://swarmy-garage:3900',
      S3_REGION: 'swarmy',
      S3_BUCKET: 'assets',
      S3_ACCESS_KEY_ID: 'GK1',
      S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/swarmy-s3-web-assets',
    });
    // detach removes exactly what attach added
    expect(Object.keys(env).sort()).toEqual([...ATTACH_ENV_KEYS].sort());
    // the actual secret value must never be an env var
    expect(Object.keys(env)).not.toContain('S3_SECRET_ACCESS_KEY');
  });
});

describe('rotatedSecretName (secret-family versioning for key rotation)', () => {
  it('turns the attach-time secret into a __v2 family member', () => {
    expect(rotatedSecretName('swarmy-s3-api-app-uploads')).toEqual({
      family: 'swarmy-s3-api-app-uploads',
      name: 'swarmy-s3-api-app-uploads__v2',
    });
  });

  it('bumps an already-rotated secret to the next version', () => {
    expect(rotatedSecretName('swarmy-s3-api-app-uploads__v2')).toEqual({
      family: 'swarmy-s3-api-app-uploads',
      name: 'swarmy-s3-api-app-uploads__v3',
    });
  });

  it("keeps the physical name inside Docker's 64-char cap", () => {
    const long = `swarmy-s3-${'a'.repeat(60)}`;
    const { family, name } = rotatedSecretName(long);
    expect(family.length).toBeLessThanOrEqual(56);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe(`${family}__v2`);
  });
});
