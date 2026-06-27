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

export interface IngressDomain {
  id: string;
  host: string;
  service_id: string;
  service_name: string;
  target_port: number;
  tls: 'auto' | 'off' | 'custom';
  path_prefix: string | null;
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

export interface DnsRecord {
  id: string;
  host: string;
  region: string;
  target_ingress: string;
  healthy: boolean;
}

export interface DnsRecordList {
  data: DnsRecord[];
  next_cursor: string | null;
}

export interface UpsertDnsRecordRequest {
  host: string;
  region: string;
  target_ingress: string;
  healthy?: boolean;
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
