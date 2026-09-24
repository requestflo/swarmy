/**
 * The slice of the NetBird Admin REST API swarmy drives for the self-hosted
 * control plane and people access (v0.79, checked against a live server in the
 * M0 spike — plans/epic-self-hosted-mesh-and-fleets.md §11).
 *
 * {@link NetbirdAdminApi} is the seam: the real HTTP client implements it
 * ({@link NetbirdAdmin}); tests implement it in memory. The diff logic in
 * `people-sync.ts` only ever talks to this interface.
 */
import { MeshControlPlaneError } from '../errors';

export interface NbGroup {
  id: string;
  name: string;
  peers?: { id: string; name?: string }[] | null;
}
export interface NbPolicyRule {
  id?: string;
  name: string;
  enabled: boolean;
  action: 'accept' | 'drop';
  bidirectional: boolean;
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  ports?: string[] | null;
  sources?: ({ id: string; name?: string } | string)[] | null;
  destinations?: ({ id: string; name?: string } | string)[] | null;
  destinationResource?: { id: string; type: 'host' | 'subnet' | 'domain' } | null;
}
export interface NbPolicy {
  id?: string;
  name: string;
  description?: string;
  enabled: boolean;
  rules: NbPolicyRule[];
}
export interface NbNetwork {
  id: string;
  name: string;
  description?: string;
  resources?: string[];
  routers?: string[];
}
export interface NbResource {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  groups: { id: string; name?: string }[];
}
export interface NbRouter {
  id: string;
  peer_groups?: string[] | null;
  masquerade: boolean;
  metric: number;
  enabled: boolean;
}
export interface NbRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
}
export interface NbZone {
  id: string;
  name: string;
  domain: string;
  enabled: boolean;
  enable_search_domain: boolean;
  distribution_groups: string[];
  records?: NbRecord[];
}
export interface NbUser {
  id: string;
  email: string;
  name: string;
  role: string;
  auto_groups: string[];
  is_blocked: boolean;
  is_service_user?: boolean;
  idp_id?: string;
  last_login?: string;
}
export interface NbPeerFull {
  id: string;
  name: string;
  hostname?: string;
  ip: string;
  connected: boolean;
  last_seen?: string;
  last_login?: string;
  login_expired?: boolean;
  user_id?: string;
  os?: string;
  version?: string;
  connection_ip?: string;
  groups?: { id: string; name: string }[];
}
export interface NbIdentityProvider {
  id: string;
  name: string;
  type: string;
  issuer: string;
  client_id: string;
}
export interface NbAccount {
  id: string;
  settings: Record<string, unknown> & { extra?: Record<string, unknown> };
}

export interface NetbirdAdminApi {
  listGroups(): Promise<NbGroup[]>;
  createGroup(name: string): Promise<NbGroup>;
  deleteGroup(id: string): Promise<void>;

  listPolicies(): Promise<NbPolicy[]>;
  createPolicy(p: NbPolicy): Promise<NbPolicy>;
  updatePolicy(id: string, p: NbPolicy): Promise<NbPolicy>;
  deletePolicy(id: string): Promise<void>;

  listNetworks(): Promise<NbNetwork[]>;
  createNetwork(n: { name: string; description?: string }): Promise<NbNetwork>;
  deleteNetwork(id: string): Promise<void>;
  listResources(networkId: string): Promise<NbResource[]>;
  createResource(networkId: string, r: { name: string; address: string; enabled: boolean; groups: string[] }): Promise<NbResource>;
  updateResource(networkId: string, id: string, r: { name: string; address: string; enabled: boolean; groups: string[] }): Promise<NbResource>;
  deleteResource(networkId: string, id: string): Promise<void>;
  listRouters(networkId: string): Promise<NbRouter[]>;
  createRouter(networkId: string, r: { peer_groups: string[]; masquerade: boolean; metric: number; enabled: boolean }): Promise<NbRouter>;
  deleteRouter(networkId: string, id: string): Promise<void>;

  listZones(): Promise<NbZone[]>;
  createZone(z: { name: string; domain: string; enabled: boolean; enable_search_domain: boolean; distribution_groups: string[] }): Promise<NbZone>;
  updateZone(id: string, z: { name: string; domain: string; enabled: boolean; enable_search_domain: boolean; distribution_groups: string[] }): Promise<NbZone>;
  deleteZone(id: string): Promise<void>;
  createRecord(zoneId: string, r: { name: string; type: string; content: string; ttl: number }): Promise<NbRecord>;
  updateRecord(zoneId: string, id: string, r: { name: string; type: string; content: string; ttl: number }): Promise<NbRecord>;
  deleteRecord(zoneId: string, id: string): Promise<void>;

  listUsers(): Promise<NbUser[]>;
  updateUser(id: string, u: { role: string; auto_groups: string[]; is_blocked: boolean }): Promise<NbUser>;
  listPeersFull(): Promise<NbPeerFull[]>;
  deletePeer(id: string): Promise<void>;

  createSetupKey(k: {
    name: string;
    type: 'one-off' | 'reusable';
    expires_in: number;
    auto_groups: string[];
    usage_limit: number;
    ephemeral: boolean;
  }): Promise<{ id: string; key: string }>;

  listIdentityProviders(): Promise<NbIdentityProvider[]>;
  createIdentityProvider(p: { type: 'oidc'; name: string; issuer: string; client_id: string; client_secret: string }): Promise<NbIdentityProvider>;
  updateIdentityProvider(id: string, p: { type: 'oidc'; name: string; issuer: string; client_id: string; client_secret: string }): Promise<NbIdentityProvider>;

  getAccount(): Promise<NbAccount>;
  updateAccountSettings(id: string, settings: NbAccount['settings']): Promise<NbAccount>;
}

export interface NetbirdAdminOptions {
  managementUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** The real HTTP client for {@link NetbirdAdminApi}. */
export class NetbirdAdmin implements NetbirdAdminApi {
  protected readonly base: string;
  protected readonly token: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(opts: NetbirdAdminOptions) {
    if (!opts.managementUrl) throw new MeshControlPlaneError('netbird', 'management URL is required');
    if (!opts.token) throw new MeshControlPlaneError('netbird', 'service token is required (missing credentials)');
    this.base = opts.managementUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  protected async api<T>(path: string, init?: RequestInit): Promise<T> {
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
      throw new MeshControlPlaneError('netbird', `request to ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new MeshControlPlaneError('netbird', `${init?.method ?? 'GET'} ${path} → ${res.status} ${body}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  /** GET a list; NetBird answers `null` for an empty one. */
  private async list<T>(path: string): Promise<T[]> {
    const r = await this.api<T[] | null>(path);
    return Array.isArray(r) ? r : [];
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.api<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }
  private put<T>(path: string, body: unknown): Promise<T> {
    return this.api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }
  private del(path: string): Promise<void> {
    return this.api<void>(path, { method: 'DELETE' });
  }

  listGroups = () => this.list<NbGroup>('/groups');
  createGroup = (name: string) => this.post<NbGroup>('/groups', { name });
  deleteGroup = (id: string) => this.del(`/groups/${id}`);

  listPolicies = () => this.list<NbPolicy>('/policies');
  createPolicy = (p: NbPolicy) => this.post<NbPolicy>('/policies', p);
  updatePolicy = (id: string, p: NbPolicy) => this.put<NbPolicy>(`/policies/${id}`, p);
  deletePolicy = (id: string) => this.del(`/policies/${id}`);

  listNetworks = () => this.list<NbNetwork>('/networks');
  createNetwork = (n: { name: string; description?: string }) => this.post<NbNetwork>('/networks', n);
  deleteNetwork = (id: string) => this.del(`/networks/${id}`);
  listResources = async (nid: string) =>
    (await this.list<NbResource>(`/networks/${nid}/resources`)).map((r) => ({ ...r, groups: r.groups ?? [] }));
  createResource = (nid: string, r: { name: string; address: string; enabled: boolean; groups: string[] }) =>
    this.post<NbResource>(`/networks/${nid}/resources`, r);
  updateResource = (nid: string, id: string, r: { name: string; address: string; enabled: boolean; groups: string[] }) =>
    this.put<NbResource>(`/networks/${nid}/resources/${id}`, r);
  deleteResource = (nid: string, id: string) => this.del(`/networks/${nid}/resources/${id}`);
  listRouters = (nid: string) => this.list<NbRouter>(`/networks/${nid}/routers`);
  createRouter = (nid: string, r: { peer_groups: string[]; masquerade: boolean; metric: number; enabled: boolean }) =>
    this.post<NbRouter>(`/networks/${nid}/routers`, r);
  deleteRouter = (nid: string, id: string) => this.del(`/networks/${nid}/routers/${id}`);

  listZones = async () => (await this.list<NbZone>('/dns/zones')).map((z) => ({ ...z, records: z.records ?? [], distribution_groups: z.distribution_groups ?? [] }));
  createZone = (z: { name: string; domain: string; enabled: boolean; enable_search_domain: boolean; distribution_groups: string[] }) =>
    this.post<NbZone>('/dns/zones', z);
  updateZone = (id: string, z: { name: string; domain: string; enabled: boolean; enable_search_domain: boolean; distribution_groups: string[] }) =>
    this.put<NbZone>(`/dns/zones/${id}`, z);
  deleteZone = (id: string) => this.del(`/dns/zones/${id}`);
  createRecord = (zid: string, r: { name: string; type: string; content: string; ttl: number }) =>
    this.post<NbRecord>(`/dns/zones/${zid}/records`, r);
  updateRecord = (zid: string, id: string, r: { name: string; type: string; content: string; ttl: number }) =>
    this.put<NbRecord>(`/dns/zones/${zid}/records/${id}`, r);
  deleteRecord = (zid: string, id: string) => this.del(`/dns/zones/${zid}/records/${id}`);

  listUsers = async () => (await this.list<NbUser>('/users')).map((u) => ({ ...u, auto_groups: u.auto_groups ?? [] }));
  updateUser = (id: string, u: { role: string; auto_groups: string[]; is_blocked: boolean }) => this.put<NbUser>(`/users/${id}`, u);
  listPeersFull = () => this.list<NbPeerFull>('/peers');
  deletePeer = (id: string) => this.del(`/peers/${id}`);

  createSetupKey = (k: {
    name: string;
    type: 'one-off' | 'reusable';
    expires_in: number;
    auto_groups: string[];
    usage_limit: number;
    ephemeral: boolean;
  }) => this.post<{ id: string; key: string }>('/setup-keys', k);

  listIdentityProviders = () => this.list<NbIdentityProvider>('/identity-providers');
  createIdentityProvider = (p: { type: 'oidc'; name: string; issuer: string; client_id: string; client_secret: string }) =>
    this.post<NbIdentityProvider>('/identity-providers', p);
  updateIdentityProvider = (id: string, p: { type: 'oidc'; name: string; issuer: string; client_id: string; client_secret: string }) =>
    this.put<NbIdentityProvider>(`/identity-providers/${id}`, p);

  getAccount = async () => {
    const all = await this.list<NbAccount>('/accounts');
    if (!all[0]) throw new MeshControlPlaneError('netbird', 'no account on this control plane (setup not done?)');
    return all[0];
  };
  updateAccountSettings = (id: string, settings: NbAccount['settings']) => this.put<NbAccount>(`/accounts/${id}`, { settings });
}
