/**
 * The activator's `return` target is only ever the cold request itself: a
 * same-origin path, or an absolute http(s) URL on the SAME host the request
 * came in on (every ingress driver's cold route keeps the app's Host). Anything
 * else is dropped, so the unauthenticated `/_wake` route is not an open redirect.
 */
export function safeReturn(back: string | undefined, hostHeader: string | undefined): string | null {
  if (!back) return null;
  if (back.startsWith('/')) return back.startsWith('//') || back.startsWith('/\\') ? null : back;
  if (!hostHeader) return null;
  let u: URL;
  try {
    u = new URL(back);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const reqHost = hostHeader.trim().toLowerCase().replace(/:\d+$/, '');
  return u.hostname.toLowerCase() === reqHost ? u.toString() : null;
}
