/**
 * Wave G1 — additional public REST DTOs for the expanded CRUD surface
 * (api-keys, node actions, geo-DNS records, backups + snapshots, cluster
 * volumes, mesh routes).
 *
 * Kept in a separate file from the shared `dto.ts` so this wave merges cleanly.
 * Same conventions as `dto.ts`: snake_case JSON fields, `.openapi(name)` on every
 * schema, request bodies suffixed `Body`.
 */
import { z } from '@hono/zod-openapi';

// ── API keys ────────────────────────────────────────────────────────────────

export const ApiKeyDto = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.enum(['read', 'write'])),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
    created_by_id: z.string().nullable(),
    revoked_at: z.string().nullable(),
    status: z.enum(['active', 'revoked']),
  })
  .openapi('ApiKey');

/** Returned ONCE at creation — carries the plaintext key. */
export const ApiKeyIssuedDto = ApiKeyDto.extend({
  key: z.string(),
}).openapi('ApiKeyIssued');

export const CreateApiKeyBody = z
  .object({
    name: z.string().min(1),
    scopes: z.array(z.enum(['read', 'write'])).optional(),
  })
  .openapi('CreateApiKeyRequest');

export const RevokedDto = z
  .object({ id: z.string(), revoked: z.literal(true) })
  .openapi('Revoked');

// ── Node actions ──────────────────────────────────────────────────────────────

export const NodeAvailabilityDto = z
  .object({ id: z.string(), availability: z.string() })
  .openapi('NodeAvailability');

export const NodeLabelsDto = z
  .object({ id: z.string(), labels: z.record(z.string()) })
  .openapi('NodeLabels');

export const SetNodeLabelsBody = z
  .object({ labels: z.record(z.string()) })
  .openapi('SetNodeLabelsRequest');

// ── Geo-DNS records ──────────────────────────────────────────────────────────

export const DnsZoneDto = z
  .object({
    id: z.string(),
    zone: z.string(),
    mode: z.enum(['swarmy-ns', 'cloudflare', 'route53']),
    enabled: z.boolean(),
    ttl: z.number().int(),
    serial: z.number().int(),
    apex_to_edge: z.boolean(),
    auto_www: z.boolean(),
    nameservers: z.array(
      z.object({ label: z.string(), fqdn: z.string(), ip: z.string(), node_id: z.string() }),
    ),
  })
  .openapi('DnsZone');

export const CreateDnsZoneBody = z
  .object({
    zone: z.string().min(4),
    mode: z.enum(['swarmy-ns', 'cloudflare', 'route53']).optional(),
  })
  .openapi('CreateDnsZoneRequest');

export const DnsRecordDto = z
  .object({
    id: z.string(),
    zone_id: z.string(),
    name: z.string(),
    type: z.string(),
    value: z.string(),
    ttl: z.number().int().nullable(),
    priority: z.number().int().nullable(),
  })
  .openapi('DnsRecord');

export const UpsertDnsRecordBody = z
  .object({
    name: z.string().min(1).max(253),
    type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA', 'NS']),
    value: z.string().min(1).max(4096),
    ttl: z.number().int().min(10).max(86400).optional(),
    priority: z.number().int().min(0).max(65535).optional(),
  })
  .openapi('UpsertDnsRecordRequest');

// ── Backups: targets + snapshots ──────────────────────────────────────────────

export const BackupTargetDto = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['s3', 'node']),
    endpoint: z.string().nullable(),
    bucket: z.string(),
    prefix: z.string().nullable(),
    region: z.string().nullable(),
    has_credentials: z.boolean(),
    enabled: z.boolean(),
    created_at: z.string(),
  })
  .openapi('BackupTarget');

export const AddBackupTargetBody = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['s3', 'node']),
    endpoint: z.string().optional(),
    bucket: z.string().min(1),
    prefix: z.string().optional(),
    region: z.string().optional(),
    access_key_id: z.string().optional(),
    secret_access_key: z.string().optional(),
    restic_password: z.string().optional(),
  })
  .openapi('AddBackupTargetRequest');

export const SnapshotDto = z
  .object({
    id: z.string(),
    volume: z.string(),
    target_id: z.string(),
    target_name: z.string(),
    status: z.string(),
    restic_id: z.string().nullable(),
    size_bytes: z.string().nullable(),
    error: z.string().nullable(),
    started_at: z.string(),
    finished_at: z.string().nullable(),
  })
  .openapi('Snapshot');

export const BackupVolumeBody = z
  .object({
    target_id: z.string().min(1),
    volume: z.string().min(1),
    node_id: z.string().optional(),
  })
  .openapi('BackupVolumeRequest');

export const BackupRunDto = z
  .object({
    snapshot_id: z.string(),
    restic_id: z.string(),
    size_bytes: z.string(),
  })
  .openapi('BackupRun');

export const RestoreSnapshotBody = z
  .object({
    snapshot_id: z.string().min(1),
    target_volume: z.string().optional(),
    node_id: z.string().optional(),
  })
  .openapi('RestoreSnapshotRequest');

export const RestoreResultDto = z
  .object({
    target_volume: z.string(),
    bytes_restored: z.string(),
  })
  .openapi('RestoreResult');

// ── Cluster volumes ───────────────────────────────────────────────────────────

export const ClusterVolumeDto = z
  .object({
    id: z.string(),
    name: z.string(),
    csi_driver: z.string(),
    access_mode: z.enum(['single-writer', 'multi-writer', 'multi-reader']),
    capacity_bytes: z.string().nullable(),
    status: z.string(),
    service_id: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('ClusterVolume');

export const RegisterVolumeBody = z
  .object({
    name: z.string().min(1),
    csi_driver: z.string().min(1),
    access_mode: z.enum(['single-writer', 'multi-writer', 'multi-reader']).optional(),
    capacity_bytes: z.number().int().min(0).optional(),
    options: z.record(z.string()).optional(),
    service_id: z.string().optional(),
  })
  .openapi('RegisterVolumeRequest');

// ── Mesh routes ───────────────────────────────────────────────────────────────

export const MeshRouteDto = z
  .object({
    id: z.string(),
    kind: z.string(),
    target_service_id: z.string().nullable(),
    target_stack_id: z.string().nullable(),
    cidr: z.string().nullable(),
    port: z.number().nullable(),
    principal_type: z.string(),
    principal_id: z.string(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('MeshRoute');

export const MeshConnectDto = z
  .object({
    driver: z.string(),
    address: z.string(),
    join_snippet: z.string(),
    setup_key: z.string().optional(),
  })
  .openapi('MeshConnect');

export const GrantMeshRouteDto = z
  .object({
    route: MeshRouteDto,
    connect: MeshConnectDto,
  })
  .openapi('GrantMeshRouteResult');

export const GrantMeshRouteBody = z
  .object({
    service_id: z.string().optional(),
    stack_id: z.string().optional(),
    principal_type: z.enum(['peer', 'group', 'member']).optional(),
    principal_id: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    proto: z.enum(['tcp', 'udp']).optional(),
    ttl_sec: z.number().int().min(0).optional(),
  })
  .openapi('GrantMeshRouteRequest');
