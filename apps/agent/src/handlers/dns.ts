import type { ApplyDnsPayload, ApplyDnsResult } from '@swarmy/core/protocol';

/**
 * `applyDns` — deliver a zone snapshot bundle to the node-local swarmy-dns.
 *
 * The agent is a dumb courier (same posture as applyMesh/applyIngress): it
 * POSTs the controller-composed bundle to the admin API published host-mode on
 * this node and relays the outcome. The bearer token rides this frame only
 * (JIT, mesh setup-key rule) — never persisted here.
 *
 * Retries cover the one race that matters: the swarmy-dns task is still
 * starting on a freshly-labeled node when the first push lands.
 */
const RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export async function applyDns(payload: ApplyDnsPayload): Promise<ApplyDnsResult> {
  const url = `${payload.adminUrl.replace(/\/$/, '')}/v1/snapshot`;
  let lastError = '';
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
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
      if (res.status === 401) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < RETRIES) await Bun.sleep(RETRY_DELAY_MS);
  }
  throw new Error(`applyDns failed: ${lastError}`);
}
