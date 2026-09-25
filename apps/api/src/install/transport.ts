/**
 * HTTPS-only install surface (security review H17).
 *
 * The install one-liner is `curl … | sh` as root. Over plain HTTP anyone on
 * the network path can rewrite the loader (and with it every checksum it
 * pins) and own each node that joins. So every install route — the loader,
 * the versioned installer + its checksum, the signed release manifest the
 * installer verifies against, and the agent/CLI binaries — is served over
 * HTTPS only:
 *
 *   - HTTPS (TLS on this socket, or `X-Forwarded-Proto: https` from a trusted
 *     proxy such as swarmy's own Caddy edge) → served.
 *   - The node-local bootstrap: a client on loopback (the controller host
 *     itself, the dev controller) → served. Nothing crosses a network.
 *   - Plain HTTP with an HTTPS address known (`CONTROLLER_PUBLIC_URL` is
 *     https) → 308 to the same path on it.
 *   - Plain HTTP with no HTTPS address → refused (403, a plain-words body
 *     that `curl -f` prints nothing of, so a piped shell never runs it) —
 *     unless the operator opted in with `SWARMY_ALLOW_INSECURE_INSTALL=1`
 *     (installer `--allow-insecure-install`; on by default only in dev).
 *
 * Binary BLOBS (`/install/bin/<platform>`, `/install/cli/<platform>`) are the
 * one relaxation: when there is no HTTPS address they are still served,
 * because every consumer checks them against a sha256 delivered over a
 * trusted channel (the HTTPS-fetched installer, the signed release manifest,
 * or the agent's authenticated command). Their `.sha256` / manifest files are
 * NOT blobs: those carry trust and follow the full policy.
 *
 * Pure; unit-tested in transport.test.ts.
 */

export type InstallTransportDecision =
  | { action: 'serve'; via: 'https' | 'loopback' | 'insecure-opt-in' | 'verified-blob' }
  | { action: 'redirect'; location: string }
  | { action: 'refuse'; status: 403; body: string };

/** Every route that hands out something a node runs as root (or its trust anchors). */
export function isInstallPath(pathname: string): boolean {
  return pathname === '/install.sh' || pathname.startsWith('/install/');
}

/** A binary blob whose bytes every consumer verifies against an out-of-band sha256. */
export function isVerifiedBlobPath(pathname: string): boolean {
  return /^\/install\/(bin|cli)\/[a-z0-9-]+$/.test(pathname);
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::1' || v === '0:0:0:0:0:0:0:1') return true;
  const v4 = v.startsWith('::ffff:') ? v.slice('::ffff:'.length) : v;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Did this request arrive over TLS? The socket's own scheme, or — ONLY when
 * the TCP peer is a trusted proxy — its `X-Forwarded-Proto` / RFC 7239
 * `Forwarded: proto=`. A client can never claim HTTPS by sending the header.
 */
export function requestIsHttps(i: { url: string; headers: Headers; peerIsTrustedProxy: boolean }): boolean {
  try {
    if (new URL(i.url).protocol === 'https:') return true;
  } catch {
    return false;
  }
  if (!i.peerIsTrustedProxy) return false;
  const xfp = i.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (xfp) return xfp === 'https';
  const fwd = /(?:^|[;,\s])proto=("?)(https?)\1/i.exec(i.headers.get('forwarded') ?? '');
  return fwd?.[2]?.toLowerCase() === 'https';
}

/** The controller's HTTPS base (no trailing slash), when it has one. */
export function httpsBase(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const u = new URL(publicUrl);
    if (u.protocol !== 'https:' || isLoopbackIp(u.hostname) || u.hostname === 'localhost') return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}

/** Whether plain-HTTP installs are opted in (explicit env; dev defaults on). */
export function insecureInstallAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.SWARMY_ALLOW_INSECURE_INSTALL?.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return (env.NODE_ENV ?? 'development') !== 'production';
}

export const INSECURE_REFUSAL =
  'swarmy: the installer is only served over HTTPS.\n' +
  'Over plain HTTP anyone on the network path could rewrite it and take over every node that joins.\n' +
  'Fix: give the controller an HTTPS address (install-swarmy.sh --domain <name>, or any HTTPS proxy with CONTROLLER_PUBLIC_URL=https://…),\n' +
  'or, on a network you trust, opt in with SWARMY_ALLOW_INSECURE_INSTALL=1 on the controller (install-swarmy.sh --allow-insecure-install).\n';

/** The entrypoints people pipe into `sh` (`curl -fsSL … | sh`). */
export function isPipedScriptPath(pathname: string): boolean {
  return pathname === '/install.sh' || pathname === '/install/loader.sh';
}

/**
 * The refusal as a harmless script, for the piped entrypoints: `curl -f`
 * swallows a 4xx body, so a bare 403 would only print "error: 403". This
 * prints the reason and exits 1 — it runs nothing else.
 */
export function refusalScript(body: string): string {
  const lines = body
    .trimEnd()
    .split('\n')
    .map((l) => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}' >&2`);
  return `#!/bin/sh\n${lines.join('\n')}\nexit 1\n`;
}

export function decideInstallTransport(i: {
  pathname: string;
  search: string;
  https: boolean;
  clientIp: string | null | undefined;
  publicUrl: string | null | undefined;
  allowInsecure: boolean;
}): InstallTransportDecision {
  if (i.https) return { action: 'serve', via: 'https' };
  if (isLoopbackIp(i.clientIp)) return { action: 'serve', via: 'loopback' };
  const base = httpsBase(i.publicUrl);
  if (base) return { action: 'redirect', location: `${base}${i.pathname}${i.search}` };
  if (i.allowInsecure) return { action: 'serve', via: 'insecure-opt-in' };
  if (isVerifiedBlobPath(i.pathname)) return { action: 'serve', via: 'verified-blob' };
  return { action: 'refuse', status: 403, body: INSECURE_REFUSAL };
}
