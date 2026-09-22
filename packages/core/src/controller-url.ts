/**
 * Resolve the controller's node-reachable base URL for install/repair
 * one-liners and the install loader.
 *
 * `CONTROLLER_PUBLIC_URL` stays authoritative when it's set to a real
 * (non-loopback) address. When it's unset or loopback (the dev default
 * `http://localhost:3021`), the address the REQUEST actually reached us at is
 * a far better guess — a node that fetched `/install/loader.sh` from
 * `http://192.168.1.10:3021` can obviously reach that address. Proxy headers
 * (`X-Forwarded-Host`/`-Proto`, RFC 7239 `Forwarded`) win over `Origin`, which
 * wins over `Host`. If every candidate is loopback the result is flagged so
 * the UI can tell the operator to set `CONTROLLER_PUBLIC_URL`.
 *
 * Pure + browser-safe. Every header-derived value is validated against a
 * strict host[:port] grammar because the result is baked into shell scripts —
 * a hostile Host header must never reach a `sh` body.
 */

export type ControllerUrlSource = 'config' | 'forwarded' | 'origin' | 'host' | 'default';

export interface ResolvedControllerUrl {
  /** Base URL, no trailing slash (e.g. `http://192.168.1.10:3021`). */
  url: string;
  source: ControllerUrlSource;
  /** True when `url` points at loopback — remote nodes can't reach it. */
  loopback: boolean;
  /** Operator-facing warning when `loopback` (null otherwise). */
  warning: string | null;
}

type HeaderBag = Headers | Record<string, string | string[] | undefined> | undefined;

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function header(bag: HeaderBag, name: string): string | undefined {
  if (!bag) return undefined;
  if (typeof (bag as Headers).get === 'function') return (bag as Headers).get(name) ?? undefined;
  const rec = bag as Record<string, string | string[] | undefined>;
  const v = rec[name] ?? rec[name.toLowerCase()] ?? Object.entries(rec).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(v) ? v[0] : v;
}

/** First value of a comma-separated proxy header, trimmed. */
function first(v: string | undefined): string | undefined {
  const f = v?.split(',')[0]?.trim();
  return f ? f : undefined;
}

/** Build `proto://host` from untrusted parts, or null when either is malformed. */
export function safeBaseUrl(proto: string | undefined, host: string | undefined): string | null {
  const p = (proto ?? 'http').toLowerCase().replace(/:$/, '');
  if (p !== 'http' && p !== 'https') return null;
  if (!host || !HOST_RE.test(host)) return null;
  return `${p}://${host}`;
}

/** Normalise a full URL string to `proto://host[:port]` (validated), or null. */
export function normaliseBaseUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const base = safeBaseUrl(u.protocol, u.host);
    if (!base) return null;
    // Keep a path prefix (controller mounted under a sub-path), minus trailing slash.
    const path = u.pathname.replace(/\/+$/, '');
    return /^[A-Za-z0-9._~/-]*$/.test(path) ? `${base}${path}` : null;
  } catch {
    return null;
  }
}

/** True for localhost / 127.0.0.0/8 / ::1 / 0.0.0.0 / *.localhost. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '::' ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === '::ffff:127.0.0.1'
  );
}

/** Parse the first element of an RFC 7239 `Forwarded` header into proto/host. */
function parseForwarded(v: string | undefined): { proto?: string; host?: string } {
  const el = first(v);
  if (!el) return {};
  const out: { proto?: string; host?: string } = {};
  for (const pair of el.split(';')) {
    const [k, raw] = pair.split('=').map((s) => s?.trim());
    if (!k || !raw) continue;
    const val = raw.replace(/^"|"$/g, '');
    if (k.toLowerCase() === 'proto') out.proto = val;
    if (k.toLowerCase() === 'host') out.host = val;
  }
  return out;
}

export const LOOPBACK_CONTROLLER_WARNING = (url: string): string =>
  `This controller only knows itself as ${url}, a loopback address other machines can't reach. ` +
  'Set CONTROLLER_PUBLIC_URL to an address your nodes can reach (e.g. http://<lan-ip>:3021 or https://swarmy.example.com) and restart the controller — ' +
  'or open the dashboard via that address so the generated command uses it.';

export function resolveControllerPublicUrl(opts: {
  /** Raw CONTROLLER_PUBLIC_URL (may be unset or the localhost default). */
  configured?: string | null;
  headers?: HeaderBag;
  /** Last resort when nothing else resolves. */
  fallback?: string;
}): ResolvedControllerUrl {
  const configured = normaliseBaseUrl(opts.configured);
  if (configured && !isLoopbackUrl(configured)) {
    return { url: configured, source: 'config', loopback: false, warning: null };
  }

  const h = opts.headers;
  const fwd = parseForwarded(header(h, 'forwarded'));
  const xfProto = first(header(h, 'x-forwarded-proto')) ?? fwd.proto;
  const xfHost = first(header(h, 'x-forwarded-host')) ?? fwd.host;
  const candidates: { url: string | null; source: ControllerUrlSource }[] = [
    { url: xfHost ? safeBaseUrl(xfProto ?? 'http', xfHost) : null, source: 'forwarded' },
    { url: normaliseBaseUrl(header(h, 'origin')), source: 'origin' },
    { url: safeBaseUrl(xfProto ?? 'http', first(header(h, 'host'))), source: 'host' },
  ];
  const reachable = candidates.find((c) => c.url && !isLoopbackUrl(c.url));
  if (reachable?.url) return { url: reachable.url, source: reachable.source, loopback: false, warning: null };

  // Nothing better than loopback: keep the configured value (or the first
  // header candidate, or the fallback) and flag it.
  const any =
    (configured ? { url: configured, source: 'config' as const } : null) ??
    candidates.find((c) => c.url) ??
    null;
  const url = any?.url ?? normaliseBaseUrl(opts.fallback) ?? 'http://localhost:3021';
  const loopback = isLoopbackUrl(url);
  return {
    url,
    source: any ? any.source : 'default',
    loopback,
    warning: loopback ? LOOPBACK_CONTROLLER_WARNING(url) : null,
  };
}
