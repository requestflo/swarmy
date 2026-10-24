import { describe, expect, it } from 'bun:test';
import { corsCode, corsSay, maxAgeLabel, methodLabel } from './cors-model';

const rule = (origin: string) => ({
  origins: [origin],
  methods: ['GET', 'HEAD', 'PUT'],
  allowedHeaders: ['*'],
  exposeHeaders: ['ETag'],
  maxAgeSeconds: 3600,
});

describe('corsSay', () => {
  it('counts sites and notices a laptop', () => {
    expect(corsSay(['https://shop.northwind.dev', 'http://localhost:3000'], 'PUBLIC')).toBe(
      '2 sites (one on a laptop) can load files from it straight in the browser.',
    );
    expect(corsSay(['*'], 'PUBLIC')).toBe('Any website can load files from it straight in the browser.');
  });

  it('says why rules do nothing while only apps can reach the bucket', () => {
    expect(corsSay(['https://shop.northwind.dev'], 'INTERNAL')).toMatch(/can’t reach this bucket yet/);
  });

  it('empty sells the server-side default', () => {
    expect(corsSay([], 'PUBLIC')).toMatch(/^No website/);
  });
});

describe('labels', () => {
  it('names the preflight cache and the presigned PUT', () => {
    expect(maxAgeLabel(3600)).toBe('1 hour');
    expect(maxAgeLabel(null)).toBe('not cached');
    expect(maxAgeLabel(120)).toBe('120s');
    expect(methodLabel('PUT')).toBe('PUT (presigned)');
    expect(methodLabel('GET')).toBe('GET');
  });
});

describe('corsCode (golden)', () => {
  it('shows the stored rules and the real AWS CLI call', () => {
    const [json, cli] = corsCode({ bucket: 'media', endpoint: 'https://s3.northwind.dev', rules: [rule('https://shop.northwind.dev')] });
    expect(JSON.parse(json!.code)).toEqual([
      { AllowedOrigins: ['https://shop.northwind.dev'], AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
    ]);
    expect(cli!.code).toContain('aws s3api put-bucket-cors --bucket media \\\n  --endpoint-url https://s3.northwind.dev');
    expect(cli!.code).toContain(`'{"CORSRules":[{"AllowedOrigins":["https://shop.northwind.dev"]`);
  });

  it('keeps short arrays on one line, like the board', () => {
    const [json] = corsCode({ bucket: 'media', endpoint: 'https://s3.northwind.dev', rules: [rule('https://a.dev')] });
    expect(json!.code).toBe(
      '[\n  {\n    "AllowedOrigins": ["https://a.dev"],\n    "AllowedMethods": ["GET", "HEAD", "PUT"],\n    "AllowedHeaders": ["*"],\n    "ExposeHeaders": ["ETag"],\n    "MaxAgeSeconds": 3600\n  }\n]',
    );
    expect(corsCode({ bucket: 'm', endpoint: 'http://x:1', rules: [] })[0]!.code).toBe('[]');
  });

  it('no rules is the delete call', () => {
    const [, cli] = corsCode({ bucket: 'media', endpoint: 'http://swarmy-garage:3900', rules: [] });
    expect(cli!.code).toContain('aws s3api delete-bucket-cors --bucket media --endpoint-url http://swarmy-garage:3900');
  });
});
