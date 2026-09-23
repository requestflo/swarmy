import { existsSync, readFileSync } from 'node:fs';
import type { ApplyDnsPayload, ApplyDnsResult } from '@swarmy/core/protocol';

/**
 * `applyDns` — deliver a zone snapshot bundle to the node-local swarmy-dns.
 *
 * The agent is a dumb courier (same posture as applyMesh/applyIngress): it
 * POSTs the controller-composed bundle to the node-local admin API and relays
 * the outcome. The bearer token rides this frame only (JIT, mesh setup-key
 * rule) — never persisted here.
 *
 * Reachability: swarmy-dns runs on the HOST network and binds its admin API on
 * 127.0.0.1 + the docker0 bridge address only (never public). The systemd-
 * backend agent shares the host netns, so the controller's
 * `http://127.0.0.1:53535` just works. A container-backend agent (default
 * bridge) has its OWN loopback, so when the loopback URL is unreachable from
 * inside a container we retry via the container's default gateway — the host's
 * docker0 address, where swarmy-dns also listens.
 *
 * Retries cover the one race that matters: the swarmy-dns task is still
 * starting on a freshly-labeled node when the first push lands.
 */
const RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/** Default IPv4 gateway from `/proc/net/route` text (little-endian hex). Pure. */
export function parseDefaultGateway(routeTable: string): string | undefined {
  for (const line of routeTable.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[1] !== '00000000') continue;
    const hex = cols[2]!;
    if (!/^[0-9A-Fa-f]{8}$/.test(hex) || hex === '00000000') continue;
    const n = parseInt(hex, 16);
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
  }
  return undefined;
}

function isLoopbackUrl(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}

export interface AdminUrlEnv {
  inContainer: boolean;
  gateway: string | undefined;
}

function detectEnv(): AdminUrlEnv {
  const inContainer = existsSync('/.dockerenv');
  let gateway: string | undefined;
  if (inContainer) {
    try {
      gateway = parseDefaultGateway(readFileSync('/proc/net/route', 'utf8'));
    } catch {
      gateway = undefined;
    }
  }
  return { inContainer, gateway };
}

/**
 * Admin base URLs to try, in order: the controller's URL, then (container
 * backend only, loopback URL only) the same port on the bridge gateway. Pure.
 */
export function adminUrlCandidates(adminUrl: string, env: AdminUrlEnv): string[] {
  const base = adminUrl.replace(/\/$/, '');
  const out = [base];
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return out;
  }
  if (env.inContainer && env.gateway && isLoopbackUrl(url)) {
    url.hostname = env.gateway;
    out.push(url.toString().replace(/\/$/, ''));
  }
  return out;
}

export async function applyDns(
  payload: ApplyDnsPayload,
  env: AdminUrlEnv = detectEnv(),
): Promise<ApplyDnsResult> {
  const candidates = adminUrlCandidates(payload.adminUrl, env);
  let lastError = '';
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    for (const base of candidates) {
      const url = `${base}/v1/snapshot`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(payload.adminToken ? { authorization: `Bearer ${payload.adminToken}` } : {}),
          },
          body: JSON.stringify(payload.bundle),
          signal: AbortSignal.timeout(payload.timeoutMs ?? 10_000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          applied?: boolean;
          version?: number;
          zones?: number;
          error?: string;
        };
        if (res.ok && body.applied) {
          return {
            applied: true,
            version: body.version ?? payload.bundle.version,
            zones: body.zones ?? payload.bundle.zones.length,
          };
        }
        // 409 = swarmy-dns already serves a newer bundle. Not an error: report
        // what's live so the controller reconciles instead of retrying forever.
        if (res.status === 409) {
          return {
            applied: false,
            version: body.version ?? -1,
            zones: payload.bundle.zones.length,
          };
        }
        lastError = `swarmy-dns admin ${res.status}: ${body.error ?? 'unknown error'}`;
        // 401 won't heal by retrying — the token is wrong, fail fast.
        if (res.status === 401) throw new Error(`applyDns failed: ${lastError}`);
        break; // got an HTTP answer — no point trying the next address
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('applyDns failed:')) throw err;
        // Connection refused / timeout: say WHERE, so "0 node(s) pushed" in
        // the dashboard names the real cause (e.g. swarmy-dns not running).
        lastError = `${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (attempt < RETRIES) await Bun.sleep(RETRY_DELAY_MS);
  }
  throw new Error(`applyDns failed: ${lastError}`);
}
