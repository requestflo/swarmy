/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with: `bun run scripts/gen-sdks.ts` from the repo root.
 * Source of truth: packages/api-rest/openapi.json
 */

export interface Node {
  id: string;
  name: string;
  hostname: string;
  role: 'manager' | 'worker';
  status: 'pending' | 'online' | 'offline' | 'draining';
  engine_version: string | null;
  os: string | null;
  arch: string | null;
  last_seen_at: string | null;
}

export interface NodeList {
  data: Node[];
  next_cursor: string | null;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  swarmy_code?: string;
}

export interface NodeAvailability {
  id: string;
  availability: string;
}

export interface NodeLabels {
  id: string;
  labels: {  };
}

export interface SetNodeLabelsRequest {
  labels: {  };
}

export interface Removed {
  id: string;
  removed: true;
}

export interface Service {
  id: string;
  name: string;
  image: string;
  status: string;
  replicas: { desired: number; running: number };
  ingress_enabled: boolean;
  node_id: string | null;
  stack_id: string | null;
  updated_at: string;
}

export interface ServiceList {
  data: Service[];
  next_cursor: string | null;
}

export interface DeploymentRef {
  id: string;
  deployment_id: string;
}

export interface CreateServiceRequest {
  name: string;
  image: string;
  replicas?: number;
  command?: string[];
  env?: { key: string; value: string }[];
  node_id?: string;
}

export interface ScaleServiceRequest {
  replicas: number;
}

export interface Stack {
  id: string;
  name: string;
  service_count: number;
  status: string;
  updated_at: string;
}

export interface StackList {
  data: Stack[];
  next_cursor: string | null;
}

export interface DeployStackRequest {
  name: string;
  compose_source: string;
}

export interface IngressDomainStatus {
  host: string;
  state: 'waiting_dns' | 'verified' | 'issuing' | 'active' | 'error';
  reason: string;
  warnings: string[];
  gated: boolean;
  verified_at: string | null;
  verified_manually: boolean;
  last_checked_at: string | null;
  next_check_at: string | null;
  dns: { a: string[]; aaaa: string[]; cname: string[]; matched: string[] } | null;
  certificate: { issuer: string; expires_at: string; error: string; edges: { ip: string; ok: boolean; error?: string }[]; checked_at: string } | null;
}

export interface IngressDomain {
  id: string;
  host: string;
  service_id: string;
  service_name: string;
  target_port: number;
  tls: 'auto' | 'off' | 'custom';
  path_prefix: string | null;
  www?: 'redirect-www-to-apex' | 'redirect-apex-to-www' | 'serve-both';
  companion_host?: string | null;
  auto?: boolean;
  status?: IngressDomainStatus;
  companion_status?: IngressDomainStatus;
}

export interface IngressDomainList {
  data: IngressDomain[];
  next_cursor: string | null;
}

export interface AddDomainRequest {
  host: string;
  service_id: string;
  target_port: number;
  tls?: 'auto' | 'off' | 'custom';
  path_prefix?: string;
  www?: 'redirect-www-to-apex' | 'redirect-apex-to-www' | 'serve-both';
}

export interface DnsRecordHint {
  type: 'A' | 'AAAA' | 'CNAME' | 'NS';
  name: string;
  label: string;
  value: string;
  note?: string;
}

export interface UpdateDomainRequest {
  www: 'redirect-www-to-apex' | 'redirect-apex-to-www' | 'serve-both';
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: 'read' | 'write'[];
  last_used_at: string | null;
  created_at: string;
  created_by_id: string | null;
  revoked_at: string | null;
  status: 'active' | 'revoked';
}

export interface ApiKeyList {
  data: ApiKey[];
  next_cursor: string | null;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes?: 'read' | 'write'[];
}

export interface Revoked {
  id: string;
  revoked: true;
}

export interface DnsZone {
  id: string;
  zone: string;
  mode: 'swarmy-ns' | 'cloudflare' | 'route53';
  enabled: boolean;
  ttl: number;
  serial: number;
  apex_to_edge: boolean;
  auto_www: boolean;
  nameservers: { label: string; fqdn: string; ip: string; node_id: string }[];
}

export interface DnsZoneList {
  data: DnsZone[];
  next_cursor: string | null;
}

export interface CreateDnsZoneRequest {
  zone: string;
  mode?: 'swarmy-ns' | 'cloudflare' | 'route53';
}

export interface DnsDelegationCheck {
  zone: string;
  delegated: boolean;
  public_ns: string[];
  nameservers: { fqdn: string; ip: string; reachable: boolean; serial: number; serial_matches: boolean }[];
}

export interface DnsRecord {
  id: string;
  zone_id: string;
  name: string;
  type: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

export interface DnsRecordList {
  data: DnsRecord[];
  next_cursor: string | null;
}

export interface UpsertDnsRecordRequest {
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'SRV' | 'CAA' | 'NS';
  value: string;
  ttl?: number;
  priority?: number;
}

export interface BackupTarget {
  id: string;
  name: string;
  kind: 's3' | 'node';
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  has_credentials: boolean;
  enabled: boolean;
  created_at: string;
}

export interface BackupTargetList {
  data: BackupTarget[];
  next_cursor: string | null;
}

export interface AddBackupTargetRequest {
  name: string;
  kind: 's3' | 'node';
  endpoint?: string;
  bucket: string;
  prefix?: string;
  region?: string;
  access_key_id?: string;
  secret_access_key?: string;
  restic_password?: string;
}

export interface Snapshot {
  id: string;
  volume: string;
  target_id: string;
  target_name: string;
  status: string;
  restic_id: string | null;
  size_bytes: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface SnapshotList {
  data: Snapshot[];
  next_cursor: string | null;
}

export interface BackupRun {
  snapshot_id: string;
  restic_id: string;
  size_bytes: string;
}

export interface BackupVolumeRequest {
  target_id: string;
  volume: string;
  node_id?: string;
}

export interface RestoreResult {
  target_volume: string;
  bytes_restored: string;
}

export interface RestoreSnapshotRequest {
  snapshot_id: string;
  target_volume?: string;
  node_id?: string;
}

export interface ClusterVolume {
  id: string;
  name: string;
  csi_driver: string;
  access_mode: 'single-writer' | 'multi-writer' | 'multi-reader';
  capacity_bytes: string | null;
  status: string;
  service_id: string | null;
  created_at: string;
}

export interface ClusterVolumeList {
  data: ClusterVolume[];
  next_cursor: string | null;
}

export interface RegisterVolumeRequest {
  name: string;
  csi_driver: string;
  access_mode?: 'single-writer' | 'multi-writer' | 'multi-reader';
  capacity_bytes?: number;
  options?: {  };
  service_id?: string;
}

export interface MeshRoute {
  id: string;
  kind: string;
  target_service_id: string | null;
  target_stack_id: string | null;
  cidr: string | null;
  port: number | null;
  principal_type: string;
  principal_id: string;
  expires_at: string | null;
  created_at: string;
}

export interface MeshRouteList {
  data: MeshRoute[];
  next_cursor: string | null;
}

export interface MeshConnect {
  driver: string;
  address: string;
  join_snippet: string;
  setup_key?: string;
}

export interface GrantMeshRouteResult {
  route: MeshRoute;
  connect: MeshConnect;
}

export interface GrantMeshRouteRequest {
  service_id?: string;
  stack_id?: string;
  principal_type?: 'peer' | 'group' | 'member';
  principal_id: string;
  port?: number;
  proto?: 'tcp' | 'udp';
  ttl_sec?: number;
}

export interface NotifyQueued {
  queued: true;
  to: string;
}

export interface NotifyBody {
  to: string;
  subject: string;
  body?: string;
  html?: string;
  template?: string;
  vars?: {  };
}

export interface RegistryCredential {
  id: string;
  prefix: string;
  provider: 'ghcr' | 'dockerhub' | 'gitlab' | 'ecr' | 'gcr' | 'acr' | 'generic';
  label: string | null;
  username: string;
  has_secret: true;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegistryCredentialList {
  data: RegistryCredential[];
  next_cursor: string | null;
}

export interface CreateRegistryCredentialBody {
  prefix: string;
  username: string;
  secret: string;
  provider?: 'ghcr' | 'dockerhub' | 'gitlab' | 'ecr' | 'gcr' | 'acr' | 'generic';
  label?: string | null;
}

export interface UpdateRegistryCredentialBody {
  username?: string;
  secret?: string;
  provider?: 'ghcr' | 'dockerhub' | 'gitlab' | 'ecr' | 'gcr' | 'acr' | 'generic';
  label?: string | null;
}

export interface RegistryCredentialDeleted {
  ok: true;
}

export interface RegistryTestResult {
  ok: boolean;
  status: 'ok' | 'unauthorized' | 'not_found' | 'unreachable' | 'error';
  message: string;
  checked_manifest: boolean;
}

export interface TestRegistryCredentialBody {
  image?: string;
}

export interface GitConnection {
  id: string;
  kind: 'github' | 'gitlab' | 'gitea' | 'generic';
  display_name: string;
  base_url: string;
  account: string | null;
  status: string;
  repo_count: number;
  created_at: string;
}

export interface GitConnectionList {
  data: GitConnection[];
  next_cursor: string | null;
}

export interface CreateGitConnectionBody {
  kind: 'github' | 'gitlab' | 'gitea' | 'generic';
  mode?: 'token' | 'oauth';
  base_url?: string;
  display_name?: string;
  token?: string;
  token_user?: string;
}

export interface GitRemoved {
  id: string;
  removed: true;
}

export interface GitProviderRepo {
  id: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

export interface GitProviderRepoList {
  data: GitProviderRepo[];
  next_cursor: string | null;
}

export interface GitProviderBranch {
  name: string;
  sha: string;
}

export interface GitProviderBranchList {
  data: GitProviderBranch[];
  next_cursor: string | null;
}

export interface GitRepo {
  id: string;
  kind: 'github' | 'gitlab' | 'gitea' | 'generic';
  url: string;
  branch: string;
  config_path: string;
  connection_id: string | null;
  full_name: string | null;
  autodeploy: boolean;
  service_id: string | null;
  has_token: boolean;
  created_at: string;
}

export interface GitRepoList {
  data: GitRepo[];
  next_cursor: string | null;
}

export interface LinkedGitRepo {
  id: string;
  url: string;
  branch: string;
  config_path: string;
  full_name: string | null;
  webhook: { url: string; secret: string } | null;
  deploy_key_public: string | null;
}

export interface LinkGitRepoBody {
  connection_id?: string;
  repo?: { id: string; full_name: string; clone_url: string };
  url?: string;
  branch: string;
  config_path?: string;
  deploy_key?: boolean;
}
