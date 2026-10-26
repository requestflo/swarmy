/**
 * The request id rum.js keeps for a failed same-origin fetch/XHR (board 59).
 * The edge sets `X-Request-Id` on every response (packages/ingress
 * request-id.ts); a replay names it beside the failed request so its logs
 * and trace are one search away.
 *
 * Privacy: only the header VALUE, and only when it looks like an id. Never a
 * request or response body, never another header. rum.js reads it only in
 * identified mode while a replay records (analytics mode never patches
 * fetch/XHR at all).
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** A UUID, or an app's own id token: short, no spaces, no markup. */
export const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{6,64}$/;

/**
 * The id to record for one finished request: only for a failure (4xx/5xx; a
 * network error has no response, so no id), only the first value, only when
 * it is id-shaped. `header` is the response's own reader
 * (`res.headers.get` / `xhr.getResponseHeader`).
 */
export function failedRequestId(status: number, header: (name: string) => string | null): string | undefined {
  if (!(status >= 400)) return undefined;
  let raw: string | null;
  try {
    raw = header(REQUEST_ID_HEADER);
  } catch {
    return undefined;
  }
  const first = raw?.split(',')[0]?.trim();
  return first && REQUEST_ID_RE.test(first) ? first : undefined;
}
