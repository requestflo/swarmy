import { describe, expect, test } from 'bun:test';
import { rcloneRemoteEnv, s3ProviderFor } from './rclone';

describe('rclone env config builder', () => {
  test('a remote is configured entirely through RCLONE_CONFIG_<REMOTE>_* env', () => {
    expect(
      rcloneRemoteEnv('offsite', {
        endpoint: 'https://s3.eu-central-003.backblazeb2.com',
        region: 'eu-central-003',
        accessKeyId: 'b2-key-id-123',
        secretAccessKey: 'b2-application-key-SECRET',
      }),
    ).toEqual({
      RCLONE_CONFIG_OFFSITE_TYPE: 's3',
      RCLONE_CONFIG_OFFSITE_PROVIDER: 'Other',
      RCLONE_CONFIG_OFFSITE_ENV_AUTH: 'false',
      RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID: 'b2-key-id-123',
      RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY: 'b2-application-key-SECRET',
      RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: 'true',
      RCLONE_CONFIG_OFFSITE_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
      RCLONE_CONFIG_OFFSITE_REGION: 'eu-central-003',
      RCLONE_CONFIG_OFFSITE_FORCE_PATH_STYLE: 'true',
    });
  });

  test('named providers get rclone quirks; the rest are path-style Other', () => {
    expect(s3ProviderFor(null)).toBe('AWS');
    expect(s3ProviderFor('https://s3.us-east-1.amazonaws.com')).toBe('AWS');
    expect(s3ProviderFor('https://acct.r2.cloudflarestorage.com')).toBe('Cloudflare');
    expect(s3ProviderFor('s3.wasabisys.com')).toBe('Wasabi');
    expect(s3ProviderFor('http://swarmy-garage:3900')).toBe('Other');
  });
});
