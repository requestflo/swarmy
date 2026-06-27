/**
 * Cloudflare API HTTP client (ingress-strategy epic).
 *
 * A thin, dependency-free `fetch` wrapper around the Cloudflare v4 REST API for
 * the operations swarmy needs to provision remotely-managed (token) tunnels:
 *
 *   - create / list / delete a named tunnel  (cfd_tunnel)
 *   - push the tunnel configuration          (cfd_tunnel/{id}/configurations)
 *   - upsert a proxied DNS CNAME             (zones/{zone}/dns_records)
 *
 * All calls are controller-side and authenticated with a vault-decrypted scoped
 * API token (Account: Cloudflare Tunnel Edit + Zone: DNS Edit). The token and
 * account id are passed in by the caller (tunnel.service), never read from the
 * environment, so the client stays a pure transport.
 *
 * ⚠️ UNVERIFIED AGAINST A LIVE ACCOUNT. There is no Cloudflare account in this
 * environment. The request shapes follow the documented v4 API
 * (api.cloudflare.com) but the happy/error paths have only been exercised by
 * unit tests with a stubbed `fetch` (see cloudflare.client.test.ts). Treat as
 * code-complete-but-unverified until run against real credentials.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareClientOptions {
  /** Scoped API token (bearer). Resolved from the credential vault. */
  apiToken: string;
  /** Cloudflare account id (for tunnel ops). */
  accountId: string;
  /** Override the base URL (tests). */
  baseUrl?: string;
  /** Inject a fetch impl (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A single cloudflared ingress rule (the catch-all has no hostname). */
export interface CloudflareIngressRule {
  hostname?: string;
  service: string;
  path?: string;
}

export interface CloudflareTunnel {
  id: string;
  name: string;
  /** Run token (`config_src: cloudflare`) — present on create. */
  token?: string;
  status?: string;
  deleted_at?: string | null;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  messages: unknown[];
  result: T;
}

export class CloudflareApiError extends Error {
  constructor(
    public status: number,
    public errors: { code: number; message: string }[],
    public op: string,
  ) {
    const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${status}`;
    super(`Cloudflare API ${op} failed: ${detail}`);
    this.name = 'CloudflareApiError';
  }
}

/**
 * Build the configuration payload pushed to
 * `PUT /accounts/{acct}/cfd_tunnel/{id}/configurations`. Pure — exported so it
 * can be unit-tested without any network. Always terminates the ingress array
 * with the mandatory catch-all 404 rule (de-duplicated if the caller already
 * supplied one).
 */
export function buildTunnelConfigPayload(rules: CloudflareIngressRule[]): {
  config: { ingress: CloudflareIngressRule[] };
} {
  const withoutCatchAll = rules.filter((r) => r.hostname !== undefined);
  return {
    config: {
      ingress: [...withoutCatchAll, { service: 'http_status:404' }],
    },
  };
}

export class CloudflareClient {
  private readonly token: string;
  private readonly accountId: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudflareClientOptions) {
    this.token = opts.apiToken;
    this.accountId = opts.accountId;
    this.base = opts.baseUrl ?? CF_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    op: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let envelope: CloudflareEnvelope<T> | null = null;
    try {
      envelope = (await res.json()) as CloudflareEnvelope<T>;
    } catch {
      envelope = null;
    }
    if (!res.ok || !envelope || !envelope.success) {
      throw new CloudflareApiError(res.status, envelope?.errors ?? [], op);
    }
    return envelope.result;
  }

  /** POST /accounts/{acct}/cfd_tunnel — create a remotely-managed tunnel. */
  createTunnel(name: string): Promise<CloudflareTunnel> {
    return this.request<CloudflareTunnel>('createTunnel', 'POST', `/accounts/${this.accountId}/cfd_tunnel`, {
      name,
      config_src: 'cloudflare',
    });
  }

  /** GET /accounts/{acct}/cfd_tunnel — list non-deleted tunnels. */
  listTunnels(): Promise<CloudflareTunnel[]> {
    return this.request<CloudflareTunnel[]>(
      'listTunnels',
      'GET',
      `/accounts/${this.accountId}/cfd_tunnel?is_deleted=false`,
    );
  }

  /** DELETE /accounts/{acct}/cfd_tunnel/{id}. */
  deleteTunnel(tunnelId: string): Promise<CloudflareTunnel> {
    return this.request<CloudflareTunnel>(
      'deleteTunnel',
      'DELETE',
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}`,
    );
  }

  /**
   * PUT /accounts/{acct}/cfd_tunnel/{id}/configurations — push the full,
   * declarative ingress array (always with the catch-all). Idempotent.
   */
  putTunnelConfiguration(tunnelId: string, rules: CloudflareIngressRule[]): Promise<unknown> {
    return this.request(
      'putTunnelConfiguration',
      'PUT',
      `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      buildTunnelConfigPayload(rules),
    );
  }

  /**
   * Upsert a proxied DNS CNAME `hostname → <tunnelId>.cfargotunnel.com`. Looks
   * up an existing record for the host and PATCHes it, else POSTs a new one.
   */
  async upsertDnsCname(zoneId: string, hostname: string, tunnelId: string): Promise<unknown> {
    const target = `${tunnelId}.cfargotunnel.com`;
    const existing = await this.request<{ id: string; name: string }[]>(
      'listDnsRecords',
      'GET',
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    const record = { type: 'CNAME', name: hostname, content: target, proxied: true };
    const found = existing[0];
    if (found) {
      return this.request('updateDnsRecord', 'PUT', `/zones/${zoneId}/dns_records/${found.id}`, record);
    }
    return this.request('createDnsRecord', 'POST', `/zones/${zoneId}/dns_records`, record);
  }
}
