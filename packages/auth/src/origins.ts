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
 * http URL (so the pre-cert first login passes the CSRF origin check), every
 * address the controller is served on ({@link servedOriginsFromEnv}), and the
 * dev dashboard. Deduped, order-stable.
 */
export function authTrustedOrigins(env: Env = process.env, liveHosts: readonly string[] = []): string[] {
  const out = [
    origin(env.CONTROLLER_PUBLIC_URL) ?? 'http://localhost:3021',
    origin(env.BETTER_AUTH_URL),
    origin(env.SWARMY_DIRECT_URL),
    ...servedOriginsFromEnv(env, liveHosts),
    'http://localhost:3023',
  ].filter((o): o is string => !!o);
  return [...new Set(out)];
}

// ── Every address the controller is served on (multi-homed hosts) ────────────
//
// The published port answers on EVERY address of every node (host IPs, LAN,
// mesh, public; the routing mesh publishes it swarm-wide), but the installer
// pins one LOGIN_URL, so sign-in from any other address of a multi-homed host
// failed Better Auth's origin check with INVALID_ORIGIN. The trusted set is
// built ONLY from addresses swarmy itself knows it serves on: the installer's
// host-address list (`SWARMY_DIRECT_HOSTS`), the live nodes' swarm + public
// IPs, the sslip.io names for those IPs, and the dashboard domain. Nothing is
// ever derived from the request's own Host/Origin, so an arbitrary origin can
// never become trusted.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function validIpv4(h: string): boolean {
  const m = IPV4.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** A host usable in an origin: IPv4 (not loopback/unspecified/link-local), bracketed IPv6, or a DNS name. */
function originHost(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return null;
  if (validIpv4(h)) {
    if (h.startsWith('127.') || h === '0.0.0.0' || h.startsWith('169.254.')) return null;
    return h;
  }
  if (h.includes(':')) {
    const bare = h.replace(/^\[|\]$/g, '');
    if (!/^[0-9a-f:.]+$/.test(bare) || bare === '::1' || bare === '::' || bare.startsWith('fe80')) return null;
    return `[${bare}]`;
  }
  if (/^[\d.]+$/.test(h)) return null; // numeric but not a valid IPv4
  return HOSTNAME.test(h) ? h : null;
}

/**
 * PURE — the origins a controller served on `hosts` (published `port`) answers:
 * `http://<host>:<port>` for each, plus the installer's sslip.io dashboard
 * names for each IPv4 (`https://swarmy.<a-b-c-d>.sslip.io`, and its
 * `http://…:<port>` form) and `https://<dashboardDomain>`.
 */
export function servedOrigins(input: {
  hosts: readonly string[];
  port: number | string;
  dashboardDomain?: string | null;
}): string[] {
  const port = String(input.port || 3021);
  const out: string[] = [];
  for (const raw of input.hosts) {
    const h = originHost(raw);
    if (!h) continue;
    out.push(`http://${h}:${port}`);
    if (validIpv4(h)) {
      const sslip = `swarmy.${h.replace(/\./g, '-')}.sslip.io`;
      out.push(`https://${sslip}`, `http://${sslip}:${port}`);
    }
  }
  const dash = input.dashboardDomain ? originHost(input.dashboardDomain) : null;
  if (dash) out.push(`https://${dash}`);
  return [...new Set(out)];
}

/** Host list in `SWARMY_DIRECT_HOSTS` (space/comma separated; the installer's host addresses). */
export function directHostsFromEnv(env: Env = process.env): string[] {
  return (env.SWARMY_DIRECT_HOSTS ?? '').split(/[\s,]+/).filter(Boolean);
}

/** The published port the direct origin uses (from `SWARMY_DIRECT_URL`, default 3021). */
function directPort(env: Env): string {
  try {
    const u = env.SWARMY_DIRECT_URL ? new URL(env.SWARMY_DIRECT_URL.trim()) : null;
    return u?.port || '3021';
  } catch {
    return '3021';
  }
}

/** {@link servedOrigins} over the installer's host list + `liveHosts` (live node IPs). */
export function servedOriginsFromEnv(env: Env = process.env, liveHosts: readonly string[] = []): string[] {
  return servedOrigins({
    hosts: [...directHostsFromEnv(env), ...liveHosts],
    port: directPort(env),
    dashboardDomain: env.SWARMY_DASHBOARD_DOMAIN,
  });
}

let liveHostsProvider: () => readonly string[] = () => [];

/**
 * Register where live node addresses come from (the controller's hub: swarm
 * advertise addresses + stamped public IPs). Read on every auth request, so a
 * node that joins is trusted without a restart.
 */
export function setServedHostsProvider(fn: () => readonly string[]): void {
  liveHostsProvider = fn;
}

function liveHostsNow(): readonly string[] {
  try {
    return liveHostsProvider();
  } catch {
    return [];
  }
}

/** Better Auth `trustedOrigins` as a function — the env set plus live node addresses. */
export function trustedOriginsNow(env: Env = process.env): string[] {
  return authTrustedOrigins(env, liveHostsNow());
}

/**
 * Matcher for the plain-http direct origins (the `host[:port]` Host header),
 * when the auth base URL is https (i.e. Better Auth issues `__Secure-`
 * cookies). Null ⇒ no translation. Covers the configured `SWARMY_DIRECT_URL`
 * and every served http origin, so sign-in keeps its session on any of them.
 */
export function directHttpHost(env: Env = process.env): ((host: string) => boolean) | null {
  const base = origin(env.BETTER_AUTH_URL);
  if (!base?.startsWith('https://')) return null;
  const fixed = new Set<string>();
  const direct = env.SWARMY_DIRECT_URL?.trim();
  if (direct) {
    try {
      const u = new URL(direct);
      if (u.protocol === 'http:') fixed.add(u.host.toLowerCase());
    } catch {
      // ignore a malformed direct URL
    }
  }
  const httpHosts = (list: readonly string[]) =>
    list.filter((o) => o.startsWith('http://')).map((o) => new URL(o).host.toLowerCase());
  for (const h of httpHosts(servedOriginsFromEnv(env))) fixed.add(h);
  return (host) => fixed.has(host) || httpHosts(servedOriginsFromEnv(env, liveHostsNow())).includes(host);
}

type DirectMatcher = string | null | ((host: string) => boolean);

function isDirect(req: Request, host: DirectMatcher): boolean {
  if (!host) return false;
  const h = (req.headers.get('host') ?? '').trim().toLowerCase();
  return typeof host === 'string' ? h === host : host(h);
}

/**
 * Inbound: on the direct http origin, rename `<prefix>.*` cookies to the
 * `__Secure-<prefix>.*` names Better Auth reads. Returns `req` untouched when
 * not applicable. The body is carried over; don't read `req` afterwards.
 */
export function adaptDirectHttpRequest(req: Request, host: DirectMatcher, cookiePrefix = 'swarmy'): Request {
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
export function adaptDirectHttpResponse(req: Request, res: Response, host: DirectMatcher): Response {
  if (!isDirect(req, host)) return res;
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-cookie');
  for (const c of cookies) headers.append('set-cookie', downgradeSetCookie(c));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
