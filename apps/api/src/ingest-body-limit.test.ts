import { describe, expect, it } from 'bun:test';
import { ARTIFACT_UPLOAD_MAX_BODY_BYTES, ERRORS_INGEST_MAX_BODY_BYTES, errorsIngestApp } from './errors-ingest';
import { RUM_MAX_BODY_BYTES, rumApp } from './rum';

/** A chunked body (no Content-Length) that streams `limit + 1 MiB` of zeros. */
function chunked(limit: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent > limit) return ctrl.close();
      sent += chunk.length;
      ctrl.enqueue(chunk);
    },
  });
}

const post = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, path: string, limit: number) =>
  app.request(path, { method: 'POST', body: chunked(limit), duplex: 'half' } as RequestInit);

describe('public ingest body caps (enforced before any body read)', () => {
  it('Sentry envelope/store: oversized chunked body → 413', async () => {
    for (const path of ['/api/42/envelope/', '/api/42/store/']) {
      const res = await post(errorsIngestApp, path, ERRORS_INGEST_MAX_BODY_BYTES);
      expect(res.status).toBe(413);
    }
  });

  it('Sentry envelope: oversized Content-Length → 413', async () => {
    const big = new Uint8Array(ERRORS_INGEST_MAX_BODY_BYTES + 1);
    const res = await errorsIngestApp.request('/api/42/envelope/', { method: 'POST', body: big });
    expect(res.status).toBe(413);
  });

  it('source-map upload: oversized chunked body → 413 before the form is parsed', async () => {
    const res = await post(errorsIngestApp, '/errors/v1/stacks/shop/releases/_/files', ARTIFACT_UPLOAD_MAX_BODY_BYTES);
    expect(res.status).toBe(413);
  });

  it('RUM beacons + replay chunks: oversized chunked body → 413', async () => {
    for (const path of ['/rum', '/replay']) {
      const res = await post(rumApp, path, RUM_MAX_BODY_BYTES);
      expect(res.status).toBe(413);
    }
  });
});
