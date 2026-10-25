import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '@swarmy/trpc';
import { createRestApp } from './app';

/** A body Hono can't parse is the caller's mistake: 400 problem+json, never a 500. */
describe('a malformed JSON body', () => {
  it('answers 400 problem+json, not 500', async () => {
    const app = createRestApp({
      resolveContextFromApiKey: async () => ({ ctx: { activeOrgId: 'org1' } as unknown as OrgContext, apiKey: { id: 'k1', scopes: ['write'] } }),
    });
    const res = await app.request('/alert-rules', {
      method: 'POST',
      headers: { authorization: 'Bearer swk_test_x', 'content-type': 'application/json' },
      body: '{"signal": ',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await res.json()) as object).toMatchObject({ status: 400, detail: 'Malformed JSON in request body' });
  });
});
