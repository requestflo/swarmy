/**
 * Inbound webhook templating (slice B4 follow-up) — a small PURE handlebars-ish
 * resolver shared by the public receiver (`inbound-hooks.ts`, response
 * templates) and the dispatch worker (`workers/inbound-webhook-dispatch.ts`,
 * request/body transform templates).
 *
 * Variables (same `{{ var }}` grammar as the notifications interpolate() —
 * regex `/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g`, unknown vars left VERBATIM so
 * typos stay visible in the delivered payload):
 *
 *   {{body}}             the raw request body, untouched
 *   {{headers.<name>}}   a captured request header (names are lowercased)
 *   {{json.<dot.path>}}  a value out of the JSON-parsed body (array indexes
 *                        ride the same dots: `json.items.0.sku`); objects and
 *                        arrays are re-serialized, null renders as "null"
 *   {{slug}}             the endpoint slug
 *   {{deliveryId}}       the persisted InboundDelivery id
 */

const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export interface InboundTemplateContext {
  /** Raw request body exactly as received. */
  body: string;
  /** Captured headers, LOWERCASE-keyed. */
  headers: Record<string, string>;
  /** Endpoint slug (public URL path segment). */
  slug: string;
  /** Persisted delivery id. */
  deliveryId: string;
}

/** Walk a dot path into parsed JSON; undefined when any hop is missing. */
export function jsonAtPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(seg, 10);
      if (!Number.isInteger(idx) || String(idx) !== seg) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** JSON value → substitution string; undefined = "leave the var verbatim". */
export function stringifyTemplateValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Render one template against a delivery. Pure; never throws. Unknown vars
 * (and `json.*` vars when the body is not valid JSON) are left verbatim.
 */
export function renderInboundTemplate(template: string, ctx: InboundTemplateContext): string {
  let parsed: unknown;
  let parsedOnce = false;
  const jsonRoot = (): unknown => {
    if (!parsedOnce) {
      parsedOnce = true;
      try {
        parsed = JSON.parse(ctx.body) as unknown;
      } catch {
        parsed = undefined;
      }
    }
    return parsed;
  };

  return template.replace(VAR_RE, (match, name: string) => {
    if (name === 'body') return ctx.body;
    if (name === 'slug') return ctx.slug;
    if (name === 'deliveryId') return ctx.deliveryId;
    if (name.startsWith('headers.')) {
      const value = ctx.headers[name.slice('headers.'.length).toLowerCase()];
      return value === undefined ? match : value;
    }
    if (name.startsWith('json.')) {
      const value = stringifyTemplateValue(jsonAtPath(jsonRoot(), name.slice('json.'.length).split('.')));
      return value === undefined ? match : value;
    }
    return match;
  });
}

/**
 * `headersJson` column → lowercase-keyed string record (documented mirror of
 * `parseHeadersJson` in @swarmy/trpc inboundWebhooks.service.ts — this app can
 * only import the trpc package root, which does not export it).
 */
export function normalizeHeadersJson(json: unknown): Record<string, string> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

/** Best content type for a rendered response body (templated acks). */
export function templateContentType(rendered: string): string {
  try {
    JSON.parse(rendered);
    return 'application/json; charset=utf-8';
  } catch {
    return 'text/plain; charset=utf-8';
  }
}
