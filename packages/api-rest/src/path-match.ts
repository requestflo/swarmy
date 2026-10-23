/**
 * Matching a request against the OpenAPI path templates (`/stacks/{id}`) the
 * routes are declared with — shared by the gates that run app-wide BEFORE
 * Hono has picked a route (the app-scope gate, deprecation signals).
 */

/** A request path relative to the `/api/v1` mount, without a trailing slash. */
export function relativePath(path: string): string {
  const i = path.indexOf('/api/v1/');
  const rel = i >= 0 ? path.slice(i + '/api/v1'.length) : path;
  return rel.length > 1 && rel.endsWith('/') ? rel.slice(0, -1) : rel;
}

export interface PathTemplate {
  re: RegExp;
  /** The `{param}` names, in order. */
  names: string[];
}

/** Compile an OpenAPI path template: each `{param}` matches one segment. */
export function compileTemplate(path: string): PathTemplate {
  const names: string[] = [];
  const re = new RegExp(
    `^${path.replace(/\{(\w+)\}/g, (_m, n: string) => {
      names.push(n);
      return '([^/]+)';
    })}$`,
  );
  return { re, names };
}

/** The decoded params when `path` matches the template, else null. */
export function matchTemplate(t: PathTemplate, path: string): Record<string, string> | null {
  const hit = t.re.exec(path);
  if (!hit) return null;
  const params: Record<string, string> = {};
  t.names.forEach((n, i) => {
    params[n] = decodeURIComponent(hit[i + 1] ?? '');
  });
  return params;
}
