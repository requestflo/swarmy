import { describe, expect, it } from 'bun:test';
import { WEBHOOK_MAX_BODY_BYTES, webhooksApp } from './webhooks';

describe('webhook body cap (unauthenticated until the HMAC check)', () => {
  it('refuses an oversized body before any handler reads it', async () => {
    const big = 'x'.repeat(WEBHOOK_MAX_BODY_BYTES + 1);
    for (const path of ['/github', '/git/some-repo']) {
      const res = await webhooksApp.request(path, { method: 'POST', body: big, headers: { 'content-type': 'application/json' } });
      expect(res.status).toBe(413);
    }
  });

  it('refuses an oversized chunked body (no Content-Length)', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent > WEBHOOK_MAX_BODY_BYTES) return ctrl.close();
        sent += chunk.length;
        ctrl.enqueue(chunk);
      },
    });
    const res = await webhooksApp.request('/git/some-repo', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
  });
});
