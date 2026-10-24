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
  scopes: ('read' | 'deploy' | 'write' | 'secrets.read')[];
  preset: 'read' | 'deploy' | 'admin' | 'custom';
  stackNames: string[] | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  createdById: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked' | 'expired';
}

export function apiKeyToDto(k: ApiKeyViewShape) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    preset: k.preset,
    stack_names: k.stackNames,
    last_used_at: k.lastUsedAt,
    expires_at: k.expiresAt,
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
  zoneId: string;
  name: string;
  type: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

export interface DnsZoneViewShape {
  id: string;
  zone: string;
  mode: string;
  enabled: boolean;
  ttl: number;
  serial: number;
  apexToEdge: boolean;
  autoWww: boolean;
  nameservers: Array<{ label: string; fqdn: string; ip: string; nodeId: string }>;
}

export function dnsZoneToDto(zone: DnsZoneViewShape) {
  return {
    id: zone.id,
    zone: zone.zone,
    mode: zone.mode as 'swarmy-ns' | 'cloudflare' | 'route53',
    enabled: zone.enabled,
    ttl: zone.ttl,
    serial: zone.serial,
    apex_to_edge: zone.apexToEdge,
    auto_www: zone.autoWww,
    nameservers: zone.nameservers.map((ns) => ({
      label: ns.label,
      fqdn: ns.fqdn,
      ip: ns.ip,
      node_id: ns.nodeId,
    })),
  };
}

export function dnsRecordToDto(r: DnsRecordViewShape) {
  return {
    id: r.id,
    zone_id: r.zoneId,
    name: r.name,
    type: r.type,
    value: r.value,
    ttl: r.ttl,
    priority: r.priority,
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

// ── App connections + internal endpoints ──────────────────────────────────────

export interface StackEndpointsViewShape {
  stack: string;
  connectedApps: string[];
  services: {
    service: string;
    short: string;
    ports: number[];
    names: { host: string; port?: number; scope: 'app' | 'connected' | 'attached'; from?: string[] }[];
  }[];
  resources: {
    kind: 'postgres' | 'cache' | 'search' | 'vector' | 'object-storage';
    name: string;
    host: string;
    port: number;
    role?: string;
    attached: string[];
  }[];
}

export function stackEndpointsToDto(e: StackEndpointsViewShape) {
  return {
    stack: e.stack,
    connected_apps: e.connectedApps,
    services: e.services.map((s) => ({
      service: s.service,
      short_name: s.short,
      ports: s.ports,
      names: s.names.map((n) => ({
        host: n.host,
        port: n.port ?? null,
        scope: n.scope,
        reachable_from: n.from ?? [],
      })),
    })),
    resources: e.resources.map((r) => ({
      kind: r.kind,
      name: r.name,
      host: r.host,
      port: r.port,
      role: r.role ?? null,
      attached: r.attached,
    })),
  };
}

export interface StackLinkResultShape {
  stack: string;
  peer: string;
  network: string;
  services: string[];
}

export function stackConnectionToDto(r: StackLinkResultShape) {
  return { stack: r.stack, peer: r.peer, network: r.network, services: r.services };
}

// ── Join tokens ──────────────────────────────────────────────────────────────

type NodeProfileShape = 'edge' | 'storage' | 'database' | 'private-mesh' | 'default';

export interface JoinTokenViewShape {
  id: string;
  label: string | null;
  profile: NodeProfileShape | null;
  tokenPrefix: string;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: Date | null;
  status: 'active' | 'expired' | 'exhausted' | 'revoked';
}

export interface JoinTokenIssuedShape {
  id: string;
  token: string;
  expiresAt: Date;
  maxUses: number;
  label: string | null;
  profile: NodeProfileShape | null;
  meshSetupKey?: string;
  meshManagementUrl?: string;
  meshDriver?: string;
  install: { url: string; loopback: boolean; warning: string | null };
}

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
// 'default' is stored as no profile; never surface it as one.
const profileOf = (p: NodeProfileShape | null) => (p && p !== 'default' ? p : null);

export function joinTokenToDto(t: JoinTokenViewShape) {
  return {
    id: t.id,
    label: t.label,
    profile: profileOf(t.profile),
    token_prefix: t.tokenPrefix,
    created_at: t.createdAt.toISOString(),
    expires_at: isoOrNull(t.expiresAt),
    max_uses: t.maxUses,
    used_count: t.usedCount,
    revoked_at: isoOrNull(t.revokedAt),
    status: t.status,
  };
}

export function joinTokenIssuedToDto(t: JoinTokenIssuedShape) {
  return {
    id: t.id,
    token: t.token,
    label: t.label,
    profile: profileOf(t.profile),
    expires_at: t.expiresAt.toISOString(),
    max_uses: t.maxUses,
    mesh: t.meshSetupKey
      ? { setup_key: t.meshSetupKey, management_url: t.meshManagementUrl ?? null, driver: t.meshDriver ?? null }
      : null,
    install: { url: t.install.url, loopback: t.install.loopback, warning: t.install.warning },
  };
}

// ── Mesh routes ───────────────────────────────────────────────────────────────
