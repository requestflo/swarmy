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
import type { NetbirdPolicyPlan } from '../acl';
import { MeshControlPlaneError } from '../errors';

export interface NetbirdClientOptions {
  /** Management server base URL, e.g. `https://netbird.example.com`. */
  managementUrl: string;
  /** Vault-decrypted service token (PAT). */
  serviceToken: string;
  /** Setup-key TTL in seconds (single-use, short-lived). */
  setupKeyTtlSec?: number;
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
      auto_groups: [] as string[],
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

  /**
   * Reconcile a {@link NetbirdPolicyPlan} (from `buildNetbirdPolicyPlan`) into
   * the control plane: ensure groups exist, then upsert policies. Returns the
   * created/looked-up group ids keyed by name so callers can store policy refs.
   */
  async applyPolicyPlan(plan: NetbirdPolicyPlan): Promise<{ groupIds: Record<string, string>; policyIds: string[] }> {
    const existing = await this.api<NbGroup[]>('/groups');
    const byName = new Map(existing.map((g) => [g.name, g.id]));
    const groupIds: Record<string, string> = {};
    for (const g of plan.groups) {
      let id = byName.get(g.name);
      if (!id) {
        const created = await this.api<NbGroup>('/groups', {
          method: 'POST',
          body: JSON.stringify({ name: g.name }),
        });
        id = created.id;
      }
      groupIds[g.name] = id;
    }

    const policyIds: string[] = [];
    for (const p of plan.policies) {
      const created = await this.api<{ id: string }>('/policies', {
        method: 'POST',
        body: JSON.stringify({
          name: p.name,
          enabled: p.enabled,
          rules: [
            {
              name: p.name,
              enabled: p.enabled,
              sources: [groupIds[p.sourceGroup]],
              destinations: [groupIds[p.destinationGroup]],
              bidirectional: false,
              protocol: p.protocol,
              ports: p.ports,
              action: 'accept',
            },
          ],
        }),
      });
      policyIds.push(created.id);
    }
    return { groupIds, policyIds };
  }

  /** Revoke a previously-created policy (direct-route teardown). */
  async deletePolicy(policyId: string): Promise<void> {
    await this.api<void>(`/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' });
  }
}
