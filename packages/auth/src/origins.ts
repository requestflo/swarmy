/**
 * Origins + cookie handling for a controller reachable at TWO origins: its
 * https public URL (self-host: the installer's `swarmy.<ip>.sslip.io` domain,
 * served by swarmy's Caddy edge) AND the direct `http://<ip>:3021` the stack
 * publishes in host mode — the first login happens there before the ACME cert
 * exists, and it must keep working so a broken edge never locks the operator out.
 *
 * Better Auth derives the cookie `__Secure-` prefix + `Secure` attribute ONCE
 * from an https `baseURL`, and browsers refuse to store (or send) such cookies
 * on a plain-http origin — so without help, sign-in on the direct URL would
 * "succeed" and immediately bounce back to /login. {@link adaptDirectHttpRequest}
 * and {@link adaptDirectHttpResponse} translate at the controller's edge, ONLY
 * for requests addressed to the configured plain-http direct origin
 * (`SWARMY_DIRECT_URL`): inbound `swarmy.*` cookies gain the prefix Better Auth
 * expects, outbound Set-Cookie loses the prefix and the `Secure` flag. Requests
 * on the https origin (and every deployment without a direct URL) are untouched.
 * Host-header spoofing can only downgrade the spoofer's own cookies.
 */

const SECURE_PREFIX = '__Secure-';

type Env = Record<string, string | undefined>;

function origin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Better Auth `trustedOrigins`: the public URL, the auth base URL, the direct
 * http URL (so the pre-cert first login passes the CSRF origin check), and the
 * dev dashboard. Deduped, order-stable.
 */
export function authTrustedOrigins(env: Env = process.env): string[] {
  const out = [
    origin(env.CONTROLLER_PUBLIC_URL) ?? 'http://localhost:3021',
    origin(env.BETTER_AUTH_URL),
    origin(env.SWARMY_DIRECT_URL),
    'http://localhost:3023',
  ].filter((o): o is string => !!o);
  return [...new Set(out)];
}

/**
 * The `host[:port]` of the plain-http direct origin, when the auth base URL is
 * https (i.e. Better Auth issues `__Secure-` cookies). Null ⇒ no translation.
 */
export function directHttpHost(env: Env = process.env): string | null {
  const base = origin(env.BETTER_AUTH_URL);
  if (!base?.startsWith('https://')) return null;
  const direct = env.SWARMY_DIRECT_URL?.trim();
  if (!direct) return null;
  try {
    const u = new URL(direct);
    return u.protocol === 'http:' ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isDirect(req: Request, host: string | null): boolean {
  if (!host) return false;
  return (req.headers.get('host') ?? '').trim().toLowerCase() === host;
}

/**
 * Inbound: on the direct http origin, rename `<prefix>.*` cookies to the
 * `__Secure-<prefix>.*` names Better Auth reads. Returns `req` untouched when
 * not applicable. The body is carried over; don't read `req` afterwards.
 */
export function adaptDirectHttpRequest(req: Request, host: string | null, cookiePrefix = 'swarmy'): Request {
  if (!isDirect(req, host)) return req;
  const cookie = req.headers.get('cookie');
  if (!cookie) return req;
  const lead = `${cookiePrefix}.`;
  const next = cookie
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    // A pre-prefixed copy can't legitimately exist on http — drop it rather
    // than let it shadow the translated one.
    .filter((c) => !c.startsWith(SECURE_PREFIX))
    .map((c) => (c.startsWith(lead) ? `${SECURE_PREFIX}${c}` : c))
    .join('; ');
  const out = new Request(req);
  out.headers.set('cookie', next);
  return out;
}

/** Strip the `__Secure-` name prefix and the `Secure` attribute from one Set-Cookie value. */
export function downgradeSetCookie(value: string): string {
  const [pair = '', ...attrs] = value.split(';');
  const name = pair.trimStart().startsWith(SECURE_PREFIX) ? pair.trimStart().slice(SECURE_PREFIX.length) : pair;
  const kept = attrs.filter((a) => a.trim().toLowerCase() !== 'secure');
  return [name, ...kept].join(';');
}

/**
 * Outbound: on the direct http origin, rewrite every Set-Cookie so the browser
 * stores it (no `__Secure-` prefix, no `Secure`). `req` is the ORIGINAL request
 * (only its Host is read). Returns `res` untouched when not applicable.
 */
export function adaptDirectHttpResponse(req: Request, res: Response, host: string | null): Response {
  if (!isDirect(req, host)) return res;
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-cookie');
  for (const c of cookies) headers.append('set-cookie', downgradeSetCookie(c));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
