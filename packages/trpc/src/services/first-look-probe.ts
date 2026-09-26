/**
 * The one HTTPS GET behind "It's live" → first response (owner decision Q1,
 * 2026-09-26). SSRF-shaped on purpose:
 *
 *   - It dials an IP the CALLER hands it (first-look.service passes only this
 *     org's own swarmy edge IPs) and never resolves a name, so a route host
 *     pointed at 169.254.169.254 or a LAN box is never reached.
 *   - The host rides as SNI + `Host:` only; the port is 443 in the service.
 *   - At most one redirect, and only to the same host over HTTPS
 *     ({@link sameHostRedirect}); anything else is reported, not followed.
 *   - A hard timeout (5 s in the service); the body is never read past the
 *     headers.
 */
import { connect as tlsConnect } from 'node:tls';

export interface ProbeTarget {
  /** A swarmy edge IP (never a hostname). */
  ip: string;
  /** The app's routed host: SNI and the Host header. */
  host: string;
  path: string;
  timeoutMs: number;
  /** 443 unless a test says otherwise. */
  port?: number;
}

export interface ProbeTls {
  authorized: boolean;
  error: string | null;
  /** The leaf certificate's notAfter (`valid_to`, e.g. "Dec 23 10:41:00 2026 GMT"). */
  validTo: string | null;
}

export type ProbeResult =
  | { ok: true; ttfbMs: number; status: number; location: string | null; tls: ProbeTls }
  | { ok: false; error: string; tls: ProbeTls | null };

const MAX_HEAD = 16 * 1024;

/** PURE: the path to follow for a redirect, or null when it leaves the host or HTTPS. */
export function sameHostRedirect(location: string, host: string, fromPath: string): string | null {
  try {
    const u = new URL(location, `https://${host}${fromPath}`);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== host.toLowerCase()) return null;
    if (u.port && u.port !== '443') return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** PURE: status + Location from a response head. */
export function parseHead(head: string): { status: number; location: string | null } | null {
  const [line, ...rest] = head.split('\r\n');
  const m = line?.match(/^HTTP\/\d(?:\.\d)? (\d{3})/);
  if (!m) return null;
  const loc = rest.find((h) => /^location:/i.test(h));
  return { status: Number(m[1]), location: loc ? loc.slice(loc.indexOf(':') + 1).trim() : null };
}

/** One GET to `ip` as `host`; resolves (never rejects) with the first byte's timing or a plain error. */
export function httpsProbe(t: ProbeTarget): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let tls: ProbeTls | null = null;
    let firstByte: number | null = null;
    let head = '';
    let done = false;
    const sock = tlsConnect({ host: t.ip, port: t.port ?? 443, servername: t.host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const finish = (r: ProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `no answer within ${Math.round(t.timeoutMs / 1000)} s`, tls }), t.timeoutMs);
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      tls = {
        authorized: sock.authorized,
        error: sock.authorizationError ? String(sock.authorizationError) : null,
        validTo: cert?.valid_to ?? null,
      };
      sock.write(`GET ${t.path} HTTP/1.1\r\nHost: ${t.host}\r\nUser-Agent: swarmy-first-look\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (chunk: Buffer) => {
      firstByte ??= performance.now();
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1 && head.length < MAX_HEAD) return;
      const parsed = parseHead(end === -1 ? head : head.slice(0, end));
      if (!parsed || !tls) return finish({ ok: false, error: 'it answered, but not with HTTP', tls });
      finish({ ok: true, ttfbMs: Math.max(1, Math.round(firstByte - started)), status: parsed.status, location: parsed.location, tls });
    });
    sock.once('error', (e: Error) => finish({ ok: false, error: e.message, tls }));
    sock.once('close', () => finish({ ok: false, error: 'the connection closed before it answered', tls }));
  });
}
