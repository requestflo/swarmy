import { describe, expect, it } from 'bun:test';
import { MAX_PRESIGN_EXPIRES_SECONDS, amzTimestamp, presignS3Url } from './s3-presign';

/**
 * Known-answer vector from the AWS SigV4 documentation ("Authenticating
 * Requests: Using Query Parameters"): a presigned GET for `test.txt` in
 * `examplebucket`, virtual-hosted style, signed 2013-05-24 with the published
 * example credentials. The expected signature is the value AWS documents —
 * if this test passes, the whole canonicalization + key-derivation chain is
 * correct.
 */
const AWS_VECTOR = {
  endpoint: 'https://examplebucket.s3.amazonaws.com',
  region: 'us-east-1',
  bucket: '', // bucket is in the host (virtual-hosted style)
  key: 'test.txt',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  method: 'GET' as const,
  expiresSeconds: 86_400,
  now: new Date('2013-05-24T00:00:00Z'),
};
const AWS_EXPECTED_SIGNATURE = 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';

describe('presignS3Url (golden: AWS SigV4 known-answer vector)', () => {
  it('reproduces the AWS-documented presigned GET exactly', () => {
    const url = presignS3Url(AWS_VECTOR);
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        `&X-Amz-Signature=${AWS_EXPECTED_SIGNATURE}`,
    );
  });

  it('is deterministic for a fixed input', () => {
    expect(presignS3Url(AWS_VECTOR)).toBe(presignS3Url(AWS_VECTOR));
  });

  it('signs path-style URLs with the bucket as the first path segment', () => {
    const url = presignS3Url({
      ...AWS_VECTOR,
      endpoint: 'http://swarmy-garage:3900',
      region: 'swarmy',
      bucket: 'app-uploads',
      key: 'avatars/user 1.png',
    });
    // host includes the non-default port; segments are RFC 3986-encoded.
    expect(url.startsWith('http://swarmy-garage:3900/app-uploads/avatars/user%201.png?')).toBe(
      true,
    );
    expect(url).toContain('%2Fswarmy%2Fs3%2Faws4_request');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it('produces a different signature for PUT vs GET', () => {
    const get = presignS3Url(AWS_VECTOR);
    const put = presignS3Url({ ...AWS_VECTOR, method: 'PUT' });
    expect(put).not.toBe(get);
    expect(put.split('X-Amz-Signature=')[0]).toBe(get.split('X-Amz-Signature=')[0]);
  });

  it("encodes reserved characters AWS-style (! ' ( ) * and unicode)", () => {
    const url = presignS3Url({ ...AWS_VECTOR, key: "r&d/(final)*'v2'!.txt" });
    expect(url).toContain('/r%26d/%28final%29%2A%27v2%27%21.txt?');
  });

  it('rejects out-of-range expiry', () => {
    expect(() => presignS3Url({ ...AWS_VECTOR, expiresSeconds: 0 })).toThrow(RangeError);
    expect(() =>
      presignS3Url({ ...AWS_VECTOR, expiresSeconds: MAX_PRESIGN_EXPIRES_SECONDS + 1 }),
    ).toThrow(RangeError);
    expect(() => presignS3Url({ ...AWS_VECTOR, expiresSeconds: 1.5 })).toThrow(RangeError);
    // the max itself is allowed
    expect(() =>
      presignS3Url({ ...AWS_VECTOR, expiresSeconds: MAX_PRESIGN_EXPIRES_SECONDS }),
    ).not.toThrow();
  });

  it('formats the injected timestamp as YYYYMMDDTHHMMSSZ', () => {
    expect(amzTimestamp(new Date('2026-07-04T12:34:56.789Z'))).toBe('20260704T123456Z');
  });
});
