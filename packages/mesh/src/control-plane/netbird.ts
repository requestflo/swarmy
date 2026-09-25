/**
 * Real NetBird Admin API HTTP client (epic #6, Phase 2+).
 *
 * Implements {@link DriverControlPlane} against a self-hosted or external NetBird
 * management server using `fetch` and a vault-decrypted service token. Endpoints
 * follow the NetBird REST API (`/api/setup-keys`, `/api/peers`, `/api/groups`,
 * `/api/policies`, `/api/routes`).
 *
 * UNVERIFIED: there is no live NetBird control plane in this environment, so the
 * request/response shapes are coded to the documented API but have NOT been
 * exercised end-to-end. They are credential-gated — with no token the client
 * fails fast with a clear error rather than silently no-op'ing.
 */
import type { DriverControlPlane, MeshPeerInfo } from '../types';
import { MeshControlPlaneError } from '../errors';

export interface NetbirdClientOptions {
  /** Management server base URL, e.g. `https://netbird.example.com`. */
  managementUrl: string;
  /** Vault-decrypted service token (PAT). */
  serviceToken: string;
  /** Setup-key TTL in seconds (single-use, short-lived). */
  setupKeyTtlSec?: number;
  /**
   * Group every non-ephemeral (node) setup key auto-joins. When unset and the
   * control plane holds exactly one `swarmy:<c>:nodes` group (a swarmy-managed
   * NetBird), that group is used, so every caller of `createSetupKey` enrols
   * servers into the nodes ↔ nodes policy without extra plumbing. Ephemeral
   * keys (direct-connect principals) never get it.
   */
  nodeGroup?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

interface NbSetupKeyResponse {
  id: string;
  key: string;
  name: string;
  expires: string;
}

interface NbPeer {
  id: string;
  name?: string;
  ip?: string;
  connected: boolean;
  last_seen?: string;
  hostname?: string;
}

interface NbGroup {
  id: string;
  name: string;
}

export class NetbirdControlPlane implements DriverControlPlane {
  private readonly base: string;
  private readonly token: string;
  private readonly ttl: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nodeGroup?: string;

  constructor(opts: NetbirdClientOptions) {
    if (!opts.managementUrl) {
      throw new MeshControlPlaneError('netbird', 'management URL is required');
    }
    if (!opts.serviceToken) {
      throw new MeshControlPlaneError('netbird', 'service token is required (missing credentials)');
    }
    this.base = opts.managementUrl.replace(/\/+$/, '');
    this.token = opts.serviceToken;
    this.ttl = opts.setupKeyTtlSec ?? 24 * 3600;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nodeGroup = opts.nodeGroup;
  }

  /** Group ids a node key auto-joins (see {@link NetbirdClientOptions.nodeGroup}). */
  private async nodeAutoGroups(): Promise<string[]> {
    const raw = await this.api<unknown>('/groups').catch(() => []);
    const groups = Array.isArray(raw) ? (raw as NbGroup[]) : [];
    if (this.nodeGroup) {
      const g = groups.find((x) => x.name === this.nodeGroup);
      return g ? [g.id] : [];
    }
    const nodes = groups.filter((g) => /^swarmy:[a-z0-9-]+:nodes$/.test(g.name));
    return nodes.length === 1 ? [nodes[0]!.id] : [];
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api${path}`, {
        ...init,
        headers: {
          Authorization: `Token ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      throw new MeshControlPlaneError(
        'netbird',
        `request to ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new MeshControlPlaneError('netbird', `${init?.method ?? 'GET'} ${path} → ${res.status} ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async createSetupKey(opts: { nodeId: string; ephemeral?: boolean }): Promise<{ setupKey: string }> {
    const body = {
      name: `swarmy-${opts.nodeId}`,
      type: 'one-off',
      expires_in: this.ttl,
      revoked: false,
      auto_groups: opts.ephemeral ? [] : await this.nodeAutoGroups(),
      usage_limit: 1,
      ephemeral: Boolean(opts.ephemeral),
    };
    const created = await this.api<NbSetupKeyResponse>('/setup-keys', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { setupKey: created.key };
  }

  async listPeers(): Promise<MeshPeerInfo[]> {
    const peers = await this.api<NbPeer[]>('/peers');
    return peers.map((p) => ({
      peerId: p.id,
      nodeId: p.hostname ?? p.name,
      meshIp: p.ip,
      connected: p.connected,
      lastSeen: p.last_seen,
    }));
  }

  async revokePeer(peerId: string): Promise<void> {
    await this.api<void>(`/peers/${encodeURIComponent(peerId)}`, { method: 'DELETE' });
  }
}
