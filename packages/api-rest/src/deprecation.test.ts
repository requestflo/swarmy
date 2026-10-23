import { describe, expect, it } from 'bun:test';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { OrgContext } from '@swarmy/trpc';
import { buildOpenApiDocument } from './app';
import {
  DEPRECATED_EXTENSION,
  checkNotice,
  deprecate,
  deprecationHeaders,
  deprecationSignals,
  type DeprecationNotice,
} from './deprecation';
import { requireScope, type RestEnv } from './middleware';

/**
 * rest-api-surface invariant 8: `/api/v1` is frozen-additive, and an operation
 * a v2 replaces is DEPRECATED before it goes — `deprecated: true` +
 * `x-swarmy-deprecated` in the spec, `Deprecation` (RFC 9745) + `Sunset`
 * (RFC 8594) on every response it sends. One marker drives both.
 */

const NOTICE: DeprecationNotice = {
  since: '2027-01-04',
  sunset: '2027-07-05',
  successor: '/api/v2/widgets/{id}',
  link: 'https://swarmy.dev/changes/widgets-v2',
};

const ok = { content: { 'application/json': { schema: z.object({ id: z.string() }) } }, description: 'Widget' };
const problem = { content: { 'application/problem+json': { schema: z.object({ status: z.number() }) } }, description: 'Problem' };
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });

/** A tiny app wired like `buildResourceApp`: signals first, then auth, then routes. */
function widgetApp() {
  const app = new OpenAPIHono<RestEnv>();
  app.use('*', deprecationSignals(app));
  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization');
    if (!auth) return c.json({ status: 401 }, 401);
    c.set('orgCtx', {} as OrgContext);
    c.set('apiKey', { id: 'k1', scopes: auth.endsWith('write') ? ['write'] : ['read'] });
    await next();
  });
  app.openapi(
    createRoute(
      deprecate(NOTICE, {
        method: 'get',
        path: '/widgets/{id}',
        middleware: [requireScope('read')] as const,
        request: { params: idParam },
        responses: { 200: ok, 401: problem },
      }),
    ),
    (c) => c.json({ id: c.req.param('id') }, 200),
  );
  app.openapi(
    createRoute(
      deprecate(NOTICE, {
        method: 'delete',
        path: '/widgets/{id}',
        middleware: [requireScope('write')] as const,
        request: { params: idParam },
        responses: { 200: ok, 403: problem },
      }),
    ),
    (c) => c.json({ id: c.req.param('id') }, 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/widgets/{id}/parts',
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: { 200: ok },
    }),
    (c) => c.json({ id: c.req.param('id') }, 200),
  );
  return app;
}

const call = (method: string, path: string, scope?: 'read' | 'write') =>
  widgetApp().request(path, { method, headers: scope ? { authorization: `Bearer swk_${scope}` } : {} });

describe('deprecation headers (the wire)', () => {
  it('Deprecation is an RFC 9745 @epoch, Sunset an RFC 8594 HTTP-date, Link names successor + notice', () => {
    expect(deprecationHeaders(NOTICE)).toEqual({
      Deprecation: '@1799020800',
      Sunset: 'Mon, 05 Jul 2027 00:00:00 GMT',
      Link: '</api/v2/widgets/{id}>; rel="successor-version", <https://swarmy.dev/changes/widgets-v2>; rel="deprecation"',
    });
    expect(deprecationHeaders({ since: '2027-01-04T09:30:00Z', sunset: '2027-07-05' })).toEqual({
      Deprecation: '@1799055000',
      Sunset: 'Mon, 05 Jul 2027 00:00:00 GMT',
    });
  });

  it('every response of a deprecated operation carries them — success, refusal and 401', async () => {
    for (const res of [
      await call('GET', '/widgets/w1', 'read'), // 200
      await call('DELETE', '/widgets/w1', 'read'), // 403: lacks write
      await call('GET', '/widgets/w1'), // 401: no key, the route never ran
    ]) {
      expect(res.headers.get('Deprecation')).toBe('@1799020800');
      expect(res.headers.get('Sunset')).toBe('Mon, 05 Jul 2027 00:00:00 GMT');
      expect(res.headers.get('Link')).toContain('rel="successor-version"');
    }
    expect((await call('DELETE', '/widgets/w1', 'read')).status).toBe(403);
    expect((await call('GET', '/widgets/w1')).status).toBe(401);
  });

  it('a live operation sharing the path prefix (or the method) is untouched', async () => {
    const parts = await call('GET', '/widgets/w1/parts', 'read');
    expect(parts.status).toBe(200);
    expect(parts.headers.get('Deprecation')).toBeNull();
    expect(parts.headers.get('Sunset')).toBeNull();
  });

  it('matches under the /api/v1 mount too', async () => {
    const host = new OpenAPIHono();
    host.route('/api/v1', widgetApp());
    const res = await host.request('/api/v1/widgets/w1', { headers: { authorization: 'Bearer swk_read' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Deprecation')).toBe('@1799020800');
  });
});

describe('deprecation in the spec', () => {
  const doc = widgetApp().getOpenAPIDocument({ openapi: '3.1.0', info: { title: 't', version: '1' } }) as unknown as {
    paths: Record<string, Record<string, Record<string, unknown> & { responses: Record<string, { headers?: object }> }>>;
  };

  it('a deprecated operation says `deprecated: true` and carries x-swarmy-deprecated', () => {
    const op = doc.paths['/widgets/{id}']!.get!;
    expect(op.deprecated).toBe(true);
    expect(op[DEPRECATED_EXTENSION]).toEqual({
      since: '2027-01-04',
      sunset: '2027-07-05',
      successor: '/api/v2/widgets/{id}',
      link: 'https://swarmy.dev/changes/widgets-v2',
    });
    expect(Object.keys(op.responses['200']!.headers ?? {}).sort()).toEqual(['Deprecation', 'Link', 'Sunset']);
    expect(Object.keys(op.responses['401']!.headers ?? {}).sort()).toEqual(['Deprecation', 'Link', 'Sunset']);
  });

  it('a live operation carries neither', () => {
    const op = doc.paths['/widgets/{id}/parts']!.get!;
    expect(op.deprecated).toBeUndefined();
    expect(op[DEPRECATED_EXTENSION]).toBeUndefined();
    expect(op.responses['200']!.headers).toBeUndefined();
  });

  it('the v1 contract: deprecated ⇔ x-swarmy-deprecated, with sunset after since', () => {
    const v1 = buildOpenApiDocument({ resolveContextFromApiKey: async () => null }) as typeof doc;
    for (const [path, ops] of Object.entries(v1.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const ext = op[DEPRECATED_EXTENSION] as DeprecationNotice | undefined;
        expect({ op: `${method} ${path}`, deprecated: op.deprecated === true }).toEqual({
          op: `${method} ${path}`,
          deprecated: ext !== undefined,
        });
        if (ext) expect(() => checkNotice(ext)).not.toThrow();
      }
    }
  });
});

describe('the marker is checked at wiring time', () => {
  it('refuses a sunset that is not after since, and a non-ISO date', () => {
    const route = { method: 'get' as const, path: '/x', responses: { 200: ok } };
    expect(() => deprecate({ since: '2027-07-05', sunset: '2027-07-05' }, route)).toThrow(/must be after/);
    expect(() => deprecate({ since: '2027-07-05', sunset: '2027-01-04' }, route)).toThrow(/must be after/);
    expect(() => deprecate({ since: 'next week', sunset: '2027-01-04' }, route)).toThrow(/ISO 8601/);
  });
});
