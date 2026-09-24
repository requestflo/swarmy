import { describe, expect, it } from 'bun:test';
import { emailApp, parseSendBody } from './email';

describe('POST /email/v1/send body', () => {
  it('accepts a single address or a list, and the documented fields', () => {
    const r = parseSendBody({ from: 'a@example.com', to: 'b@x.test', subject: 'hi', text: 't', variables: { n: 1 } });
    expect(r.ok && r.value.to).toEqual(['b@x.test']);
  });
  it('rejects unknown fields, a missing from/to and wrong types', () => {
    const r = parseSendBody({ to: 5, attachments: [], subject: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toEqual(['unknown field "attachments"', '"from" is required', '"to" must be an address or a list of at most 50', '"subject" must be a string of at most 998 characters']);
  });
});

describe('routes', () => {
  it('bad JSON is a 400 before any auth or DB work', async () => {
    const res = await emailApp.request('/v1/send', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_json');
  });
});
