/**
 * Deprecation signalling for `/api/v1` (rest-api-surface invariant 8).
 *
 * v1 is frozen-additive: a breaking change ships as a v2 operation, and the v1
 * operation it replaces is DEPRECATED for a window before it is removed. One
 * marker on the route says so in both places a client can see:
 *
 *   - the spec: `deprecated: true` (plain OpenAPI, so every generator warns)
 *     plus `x-swarmy-deprecated: { since, sunset, successor?, link? }`, and
 *     the headers below documented on each of the operation's responses;
 *   - the wire: EVERY response of the operation — success, refusal, a 401,
 *     an idempotent replay — carries `Deprecation: @<unix seconds>`
 *     (RFC 9745), `Sunset: <HTTP-date>` (RFC 8594) and, when given, `Link`s
 *     to the replacement (`rel="successor-version"`) and to a human-readable
 *     notice (`rel="deprecation"`).
 *
 *     app.openapi(
 *       createRoute(deprecate({ since: '2027-01-04', sunset: '2027-07-05', successor: '/api/v2/stacks' }, {
 *         method: 'get', path: '/stacks', …
 *       })),
 *       handler,
 *     );
 *
 * The headers are read back from the OpenAPI registry (`deprecationSignals`),
 * so the spec and the wire cannot disagree. Nothing in v1 is deprecated yet.
 * Removing an operation after its sunset is a deliberate code change — the
 * route keeps answering (with the headers) until it is deleted.
 */
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RestEnv } from './middleware';
import { compileTemplate, relativePath, type PathTemplate } from './path-match';

/** The OpenAPI extension a deprecated operation carries. */
export const DEPRECATED_EXTENSION = 'x-swarmy-deprecated';

export interface DeprecationNotice {
  /** When the operation was deprecated — ISO 8601 date (`2027-01-04`) or date-time. */
  since: string;
  /** When it may stop answering — ISO 8601, strictly after `since`. */
  sunset: string;
  /** The operation that replaces it (`/api/v2/stacks`, or an absolute URL). */
  successor?: string;
  /** A human-readable notice: what changed and how to move. */
  link?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;

function instant(field: 'since' | 'sunset', value: string): number {
  const t = ISO_DATE.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(t)) throw new Error(`deprecate: ${field} "${value}" is not an ISO 8601 date`);
  return t;
}

/** Validate a notice (throws at wiring time, never per request). */
export function checkNotice(n: DeprecationNotice): DeprecationNotice {
  const since = instant('since', n.since);
  const sunset = instant('sunset', n.sunset);
  if (sunset <= since) throw new Error(`deprecate: sunset ${n.sunset} must be after since ${n.since}`);
  return n;
}

/** The response headers a notice puts on the wire. Pure. */
export function deprecationHeaders(n: DeprecationNotice): Record<string, string> {
  const out: Record<string, string> = {
    Deprecation: `@${Math.floor(instant('since', n.since) / 1000)}`,
    Sunset: new Date(instant('sunset', n.sunset)).toUTCString(),
  };
  const links = [
    ...(n.successor ? [`<${n.successor}>; rel="successor-version"`] : []),
    ...(n.link ? [`<${n.link}>; rel="deprecation"`] : []),
  ];
  if (links.length) out.Link = links.join(', ');
  return out;
}

const HEADER_DOCS = {
  Deprecation: {
    description: 'RFC 9745: when this operation was deprecated (`@<unix seconds>`).',
    schema: { type: 'string' as const },
  },
  Sunset: {
    description: 'RFC 8594: the HTTP-date after which this operation may stop answering.',
    schema: { type: 'string' as const },
  },
  Link: {
    description: 'The replacement (`rel="successor-version"`) and the deprecation notice (`rel="deprecation"`), when known.',
    schema: { type: 'string' as const },
  },
};

/**
 * Mark a route deprecated — wrap its config before `createRoute`. Adds
 * `deprecated: true`, the `x-swarmy-deprecated` extension, and documents the
 * signalling headers on every inline response. The route's runtime typing is
 * unchanged.
 */
export function deprecate<R extends RouteConfig>(notice: DeprecationNotice, route: R): R {
  const n = checkNotice(notice);
  const responses: RouteConfig['responses'] = {};
  for (const [status, res] of Object.entries(route.responses)) {
    if ('$ref' in res) {
      responses[status] = res; // a $ref: documented where it is defined
      continue;
    }
    const own = res.headers && !('_def' in res.headers) ? res.headers : {};
    responses[status] = { ...res, headers: { ...own, ...HEADER_DOCS } };
  }
  return {
    ...route,
    responses,
    deprecated: true,
    [DEPRECATED_EXTENSION]: {
      since: n.since,
      sunset: n.sunset,
      ...(n.successor ? { successor: n.successor } : {}),
      ...(n.link ? { link: n.link } : {}),
    },
  } as R;
}

interface CompiledRoute {
  method: string;
  template: PathTemplate;
  notice: DeprecationNotice | null;
}

/** Every registered operation, in registration order, with its notice (if any). */
export function operationTable(
  app: Pick<OpenAPIHono<RestEnv>, 'openAPIRegistry'>,
): CompiledRoute[] {
  const out: CompiledRoute[] = [];
  for (const d of app.openAPIRegistry.definitions) {
    if (d.type !== 'route') continue;
    const route = d.route as RouteConfig & { [DEPRECATED_EXTENSION]?: DeprecationNotice };
    out.push({
      method: route.method.toUpperCase(),
      template: compileTemplate(route.path),
      notice: route[DEPRECATED_EXTENSION] ?? null,
    });
  }
  return out;
}

/**
 * App-wide middleware (register it FIRST, before auth) that stamps the
 * deprecation headers on every response of a deprecated operation. The
 * operation is the first registered route matching the request — the same
 * one Hono dispatches to.
 */
export function deprecationSignals(app: Pick<OpenAPIHono<RestEnv>, 'openAPIRegistry'>): MiddlewareHandler<RestEnv> {
  // Built on first use: every route is registered by then.
  let table: CompiledRoute[] | null = null;
  return async (c, next) => {
    await next();
    table ??= operationTable(app);
    if (!table.some((r) => r.notice)) return;
    const method = c.req.method.toUpperCase() === 'HEAD' ? 'GET' : c.req.method.toUpperCase();
    const path = relativePath(c.req.path);
    const hit = table.find((r) => r.method === method && r.template.re.test(path));
    if (!hit?.notice) return;
    const headers = deprecationHeaders(hit.notice);
    try {
      for (const [k, v] of Object.entries(headers)) c.res.headers.set(k, v);
    } catch {
      // Immutable headers (a passed-through fetch Response): re-wrap it.
      const res = new Response(c.res.body, c.res);
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      c.res = res;
    }
  };
}
