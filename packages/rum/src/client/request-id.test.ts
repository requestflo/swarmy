import { describe, expect, it } from 'bun:test';
import { failedRequestId, REQUEST_ID_HEADER } from './request-id';

const UUID = '4f2a9c1e-7b3d-4e8a-9f10-2c5d6e7f8a9b';
const headers = (v: string | null) => (name: string) => (name === REQUEST_ID_HEADER ? v : null);

describe('failedRequestId — the id of a failed request, and nothing else', () => {
  it('keeps the edge id of a 4xx or 5xx response', () => {
    expect(failedRequestId(500, headers(UUID))).toBe(UUID);
    expect(failedRequestId(404, headers(UUID))).toBe(UUID);
  });
  it('never for a success, a redirect or a network error (no response, no id)', () => {
    expect(failedRequestId(200, headers(UUID))).toBeUndefined();
    expect(failedRequestId(304, headers(UUID))).toBeUndefined();
    expect(failedRequestId(0, headers(UUID))).toBeUndefined();
  });
  it('only an id-shaped value: no markup, no spaces, no essays', () => {
    expect(failedRequestId(500, headers('<script>alert(1)</script>'))).toBeUndefined();
    expect(failedRequestId(500, headers('a b c d e f'))).toBeUndefined();
    expect(failedRequestId(500, headers('x'.repeat(65)))).toBeUndefined();
    expect(failedRequestId(500, headers(null))).toBeUndefined();
    expect(failedRequestId(500, headers('req_01HZY3'))).toBe('req_01HZY3');
  });
  it('the first of several values (another proxy appended its own)', () => {
    expect(failedRequestId(502, headers(`${UUID}, upstream-77aa11`))).toBe(UUID);
  });
  it('a header reader that throws records nothing', () => {
    expect(
      failedRequestId(500, () => {
        throw new Error('refused');
      }),
    ).toBeUndefined();
  });
});
