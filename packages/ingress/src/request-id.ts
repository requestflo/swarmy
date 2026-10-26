/**
 * A request id per request at the edge (board 59: a replay names the failed
 * request's id; app logs and traces can carry the same one).
 *
 * The edge mints Caddy's `{http.request.uuid}` (one UUID per request, the same
 * value every time it's read within that request), sends it upstream as
 * `X-Request-Id` (replacing any client-sent copy, so an id in your logs is
 * always one the edge minted), and returns it on the response unless the app
 * set its own (`?`: the app's own id wins, so the browser sees the id the
 * app logged). With tracing on, the edge span carries it as
 * `swarmy.request_id`. PURE.
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';
/** Span attribute the edge span carries the request id under. */
export const REQUEST_ID_SPAN_ATTRIBUTE = 'swarmy.request_id';

/** Site-level lines: mint, send upstream, return. */
export function caddyRequestIdLines(): string[] {
  return [
    '  # swarmy request id: one per request, sent upstream and back to the browser',
    `  request_header ${REQUEST_ID_HEADER} {http.request.uuid}`,
    `  header ?${REQUEST_ID_HEADER} {http.request.uuid}`,
  ];
}

/** The edge span's attribute line (inside `span_attributes`). */
export function caddyRequestIdSpanAttribute(): string {
  return `      ${REQUEST_ID_SPAN_ATTRIBUTE} {http.request.uuid}`;
}
