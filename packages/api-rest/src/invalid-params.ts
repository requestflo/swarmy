/**
 * `invalid_params` on a 400 problem (the RFC 9457 §3 extension member): one
 * entry per refused field and why, so a client can point at every field
 * that failed, not just the first. Two sources feed it: request-body
 * validation (zod issues, already snake_case) and a service that validates
 * a whole write itself (`fieldErrors` on the TRPCError's cause, camelCase
 * service paths — translated here, the public surface is snake_case).
 */

export interface InvalidParam {
  /** The field, dotted (`tls.on_demand`, `tunnel.run_token`). */
  name: string;
  reason: string;
}

/** `tunnel.runToken` → `tunnel.run_token`. */
export function snakePath(field: string): string {
  return field
    .split('.')
    .map((seg) => seg.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
    .join('.');
}

/** From a service's `fieldErrors` ({ field, message }[]); undefined when there are none. */
export function invalidParamsFromFieldErrors(raw: unknown): InvalidParam[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: InvalidParam[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (e && typeof e.field === 'string' && typeof e.message === 'string') {
      out.push({ name: snakePath(e.field), reason: e.message });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** From request-body validation issues. */
export function invalidParamsFromIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): InvalidParam[] {
  return issues.map((i) => ({ name: i.path.map(String).join('.') || 'body', reason: i.message }));
}
