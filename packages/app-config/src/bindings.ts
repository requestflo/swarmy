/**
 * Resource → env bindings: `${{ db.url }}`.
 *
 * The double-brace form is deliberately NOT compose's `${VAR}` — a single-brace
 * `${VAR}` in a swarmy.yaml env value is left verbatim (it is the app's own
 * string), so the two never collide. A binding may be the whole value or be
 * embedded (`postgres://…?host=${{ db.host }}`). `$${{` escapes a literal.
 *
 * Namespaces:
 *   ${{ <resource>.<field> }}     a managed resource declared under `resources:`
 *   ${{ services.<name>.<field> }} another service's in-swarm address
 *   ${{ app.<field> }}            the app itself (name, url, domain — preview-aware)
 *   ${{ secrets.<name> }}         a swarmy secret's VALUE as an env var — as the
 *                                 WHOLE value it is exported at container start
 *                                 by the secret-env shim from the mounted Docker
 *                                 secret (never in the spec); embedded in a larger
 *                                 string it warns (would render into env)
 *
 * Pure: parsing + the controller-side `renderValue` over a resolved endpoint map.
 */
import type { ResourceType } from './schema';

export const BINDING_RE = /(\$?)\$\{\{\s*([^}]*?)\s*\}\}/g;

/** Fields each resource type exposes to bindings. */
export const RESOURCE_BINDING_FIELDS: Record<ResourceType, readonly string[]> = {
  postgres: ['url', 'ro_url', 'host', 'ro_host', 'port', 'database', 'user', 'password'],
  cache: ['url', 'host', 'port', 'password', 'password_file'],
  queue: ['url', 'host', 'port', 'password', 'password_file'],
  search: ['url', 'host', 'port', 'key_file'],
  vector: ['url', 'host', 'port'],
  bucket: ['endpoint', 'bucket', 'region', 'access_key_id', 'secret_access_key_file'],
};
export const SERVICE_BINDING_FIELDS = ['url', 'host', 'port'] as const;
export const APP_BINDING_FIELDS = ['name', 'url', 'domain', 'environment'] as const;

/** Names a resource/service can't take because they are binding namespaces. */
export const RESERVED_NAMES = ['app', 'apps', 'services', 'secrets', 'preview'] as const;

export type BindingRef =
  | { ns: 'resource'; name: string; field: string }
  | { ns: 'service'; name: string; field: string }
  | { ns: 'app'; field: string }
  | { ns: 'secret'; name: string };

export interface ParsedBinding {
  /** The expression between the braces, trimmed, e.g. `db.url`. */
  expr: string;
  ref: BindingRef | null;
  /** Why `ref` is null (malformed expression). */
  error?: string;
}

const SEG = /^[a-z][a-z0-9_-]*$/i;

/** Parse one expression (`db.url`) into a typed ref (existence NOT checked here). */
export function parseBindingExpr(expr: string): ParsedBinding {
  const parts = expr.split('.');
  if (parts.some((p) => !SEG.test(p)))
    return { expr, ref: null, error: `"${expr}" is not a valid binding` };
  const [a, b, c] = parts as [string, string?, string?];
  if (a === 'services') {
    if (parts.length !== 3 || !b || !c)
      return { expr, ref: null, error: 'use ${{ services.<name>.<field> }}' };
    return { expr, ref: { ns: 'service', name: b, field: c } };
  }
  if (a === 'secrets') {
    if (parts.length !== 2 || !b) return { expr, ref: null, error: 'use ${{ secrets.<name> }}' };
    return { expr, ref: { ns: 'secret', name: b } };
  }
  if (a === 'app') {
    if (parts.length !== 2 || !b) return { expr, ref: null, error: 'use ${{ app.<field> }}' };
    return { expr, ref: { ns: 'app', field: b } };
  }
  if (parts.length !== 2 || !b) return { expr, ref: null, error: 'use ${{ <resource>.<field> }}' };
  return { expr, ref: { ns: 'resource', name: a, field: b } };
}

/** Every binding in a string value (escaped `$${{ … }}` skipped). */
export function extractBindings(value: string): ParsedBinding[] {
  const out: ParsedBinding[] = [];
  for (const m of value.matchAll(BINDING_RE)) {
    if (m[1] === '$') continue;
    out.push(parseBindingExpr(m[2] ?? ''));
  }
  return out;
}

/** Stable key for a ref, e.g. `db.url`, `services.api.url`, `secrets.stripe`. */
export function refKey(ref: BindingRef): string {
  switch (ref.ns) {
    case 'resource':
      return `${ref.name}.${ref.field}`;
    case 'service':
      return `services.${ref.name}.${ref.field}`;
    case 'app':
      return `app.${ref.field}`;
    case 'secret':
      return `secrets.${ref.name}`;
  }
}

/**
 * Substitute bindings in a value from a resolved map keyed by `refKey` (the
 * controller fills it from live resource labels / secrets at apply time).
 * Returns the missing keys instead of rendering a half-resolved string.
 */
export function renderValue(
  value: string,
  resolved: Readonly<Record<string, string>>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const rendered = value.replace(BINDING_RE, (whole, esc: string, expr: string) => {
    if (esc === '$') return whole.slice(1); // `$${{ x }}` → literal `${{ x }}`
    const { ref } = parseBindingExpr(expr.trim());
    const key = ref ? refKey(ref) : expr.trim();
    const v = resolved[key];
    if (v === undefined) {
      missing.push(key);
      return whole;
    }
    return v;
  });
  return { value: rendered, missing };
}
