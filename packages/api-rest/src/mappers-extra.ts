/**
 * Wave G1 — map internal `@swarmy/trpc` service view shapes → public REST DTOs.
 *
 * Kept separate from the shared `mappers.ts` so this wave merges cleanly. The
 * input shapes are declared structurally here (rather than importing the service
 * view interfaces through the barrel) so no new `@swarmy/trpc` type export is
 * required — the mapper is the single place that absorbs camelCase→snake_case.
 */

// ── API keys ────────────────────────────────────────────────────────────────

export interface ApiKeyViewShape {
  id: string;
  name: string;
  prefix: string;
  scopes: ('read' | 'write')[];
  lastUsedAt: string | null;
  createdAt: string;
  createdById: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked';
}

export function apiKeyToDto(k: ApiKeyViewShape) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    last_used_at: k.lastUsedAt,
    created_at: k.createdAt,
    created_by_id: k.createdById,
    revoked_at: k.revokedAt,
    status: k.status,
  };
}

export function apiKeyIssuedToDto(k: ApiKeyViewShape & { key: string }) {
  return { ...apiKeyToDto(k), key: k.key };
}

// ── Geo-DNS records ──────────────────────────────────────────────────────────

export interface DnsRecordViewShape {
  id: string;
  host: string;
  region: string;
  targetIngress: string;
  healthy: boolean;
}

export function dnsRecordToDto(r: DnsRecordViewShape) {
  return {
    id: r.id,
    host: r.host,
    region: r.region,
    target_ingress: r.targetIngress,
    healthy: r.healthy,
  };
}

// ── Backups: targets + snapshots ──────────────────────────────────────────────

export interface BackupTargetViewShape {
  id: string;
  name: string;
  kind: 's3' | 'node';
  endpoint: string | null;
  bucket: string;
  prefix: string | null;
  region: string | null;
  hasCredentials: boolean;
  enabled: boolean;
  createdAt: string;
}

export function backupTargetToDto(t: BackupTargetViewShape) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    endpoint: t.endpoint,
    bucket: t.bucket,
    prefix: t.prefix,
    region: t.region,
    has_credentials: t.hasCredentials,
    enabled: t.enabled,
    created_at: t.createdAt,
  };
}

export interface SnapshotViewShape {
  id: string;
  volume: string;
  targetId: string;
  targetName: string;
  status: string;
  resticId: string | null;
  sizeBytes: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function snapshotToDto(s: SnapshotViewShape) {
  return {
    id: s.id,
    volume: s.volume,
    target_id: s.targetId,
    target_name: s.targetName,
    status: s.status,
    restic_id: s.resticId,
    size_bytes: s.sizeBytes,
    error: s.error,
    started_at: s.startedAt,
    finished_at: s.finishedAt,
  };
}

export function backupRunToDto(r: { snapshotId: string; resticId: string; sizeBytes: string }) {
  return {
    snapshot_id: r.snapshotId,
    restic_id: r.resticId,
    size_bytes: r.sizeBytes,
  };
}

export function restoreResultToDto(r: { targetVolume: string; bytesRestored: string }) {
  return {
    target_volume: r.targetVolume,
    bytes_restored: r.bytesRestored,
  };
}

// ── Cluster volumes ───────────────────────────────────────────────────────────

export interface ClusterVolumeViewShape {
  id: string;
  name: string;
  csiDriver: string;
  accessMode: 'single-writer' | 'multi-writer' | 'multi-reader';
  capacityBytes: string | null;
  status: string;
  serviceId: string | null;
  createdAt: string;
}

export function clusterVolumeToDto(v: ClusterVolumeViewShape) {
  return {
    id: v.id,
    name: v.name,
    csi_driver: v.csiDriver,
    access_mode: v.accessMode,
    capacity_bytes: v.capacityBytes,
    status: v.status,
    service_id: v.serviceId,
    created_at: v.createdAt,
  };
}

// ── Mesh routes ───────────────────────────────────────────────────────────────

export interface MeshRouteViewShape {
  id: string;
  kind: string;
  targetServiceId: string | null;
  targetStackId: string | null;
  cidr: string | null;
  port: number | null;
  principalType: string;
  principalId: string;
  expiresAt: string | null;
  createdAt: string;
}

export function meshRouteToDto(r: MeshRouteViewShape) {
  return {
    id: r.id,
    kind: r.kind,
    target_service_id: r.targetServiceId,
    target_stack_id: r.targetStackId,
    cidr: r.cidr,
    port: r.port,
    principal_type: r.principalType,
    principal_id: r.principalId,
    expires_at: r.expiresAt,
    created_at: r.createdAt,
  };
}

export interface MeshConnectShape {
  driver: string;
  address: string;
  joinSnippet: string;
  setupKey?: string;
}

export function meshConnectToDto(c: MeshConnectShape) {
  return {
    driver: c.driver,
    address: c.address,
    join_snippet: c.joinSnippet,
    ...(c.setupKey !== undefined ? { setup_key: c.setupKey } : {}),
  };
}

export function grantMeshRouteToDto(g: { route: MeshRouteViewShape; connect: MeshConnectShape }) {
  return {
    route: meshRouteToDto(g.route),
    connect: meshConnectToDto(g.connect),
  };
}
