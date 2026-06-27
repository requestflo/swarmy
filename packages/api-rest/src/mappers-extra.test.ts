import { describe, expect, it } from 'bun:test';
import {
  apiKeyIssuedToDto,
  apiKeyToDto,
  backupRunToDto,
  backupTargetToDto,
  clusterVolumeToDto,
  dnsRecordToDto,
  grantMeshRouteToDto,
  meshConnectToDto,
  meshRouteToDto,
  restoreResultToDto,
  snapshotToDto,
} from './mappers-extra';

describe('apiKeyToDto', () => {
  const view = {
    id: 'k1',
    name: 'ci',
    prefix: 'ab12cd34',
    scopes: ['read', 'write'] as const,
    lastUsedAt: '2026-06-27T00:00:00.000Z',
    createdAt: '2026-06-26T00:00:00.000Z',
    createdById: 'u1',
    revokedAt: null,
    status: 'active' as const,
  };

  it('maps camelCase view → snake_case DTO', () => {
    expect(apiKeyToDto({ ...view, scopes: ['read', 'write'] })).toEqual({
      id: 'k1',
      name: 'ci',
      prefix: 'ab12cd34',
      scopes: ['read', 'write'],
      last_used_at: '2026-06-27T00:00:00.000Z',
      created_at: '2026-06-26T00:00:00.000Z',
      created_by_id: 'u1',
      revoked_at: null,
      status: 'active',
    });
  });

  it('carries the plaintext key in the issued variant', () => {
    const dto = apiKeyIssuedToDto({ ...view, scopes: ['read'], key: 'swk_ab12cd34_secret' });
    expect(dto.key).toBe('swk_ab12cd34_secret');
    expect(dto.id).toBe('k1');
  });
});

describe('dnsRecordToDto', () => {
  it('maps targetIngress → target_ingress', () => {
    expect(
      dnsRecordToDto({ id: 'r1', host: 'app.example.com', region: 'us', targetIngress: '1.2.3.4', healthy: true }),
    ).toEqual({
      id: 'r1',
      host: 'app.example.com',
      region: 'us',
      target_ingress: '1.2.3.4',
      healthy: true,
    });
  });
});

describe('backupTargetToDto', () => {
  it('maps hasCredentials → has_credentials and createdAt → created_at', () => {
    const dto = backupTargetToDto({
      id: 't1',
      name: 'prod-s3',
      kind: 's3',
      endpoint: 'https://s3.example.com',
      bucket: 'backups',
      prefix: 'org1',
      region: 'eu',
      hasCredentials: true,
      enabled: true,
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    expect(dto.has_credentials).toBe(true);
    expect(dto.created_at).toBe('2026-06-01T00:00:00.000Z');
    expect(dto.kind).toBe('s3');
  });
});

describe('snapshotToDto', () => {
  it('maps targetId/targetName/resticId/sizeBytes/startedAt/finishedAt', () => {
    expect(
      snapshotToDto({
        id: 's1',
        volume: 'data',
        targetId: 't1',
        targetName: 'prod-s3',
        status: 'SUCCEEDED',
        resticId: 'abc',
        sizeBytes: '1024',
        error: null,
        startedAt: '2026-06-01T00:00:00.000Z',
        finishedAt: '2026-06-01T00:01:00.000Z',
      }),
    ).toEqual({
      id: 's1',
      volume: 'data',
      target_id: 't1',
      target_name: 'prod-s3',
      status: 'SUCCEEDED',
      restic_id: 'abc',
      size_bytes: '1024',
      error: null,
      started_at: '2026-06-01T00:00:00.000Z',
      finished_at: '2026-06-01T00:01:00.000Z',
    });
  });
});

describe('backupRunToDto / restoreResultToDto', () => {
  it('maps backup run result', () => {
    expect(backupRunToDto({ snapshotId: 's1', resticId: 'abc', sizeBytes: '1024' })).toEqual({
      snapshot_id: 's1',
      restic_id: 'abc',
      size_bytes: '1024',
    });
  });

  it('maps restore result', () => {
    expect(restoreResultToDto({ targetVolume: 'data', bytesRestored: '2048' })).toEqual({
      target_volume: 'data',
      bytes_restored: '2048',
    });
  });
});

describe('clusterVolumeToDto', () => {
  it('maps csiDriver/accessMode/capacityBytes/serviceId/createdAt', () => {
    expect(
      clusterVolumeToDto({
        id: 'v1',
        name: 'pg-data',
        csiDriver: 'ebs.csi.aws.com',
        accessMode: 'single-writer',
        capacityBytes: '10737418240',
        status: 'READY',
        serviceId: 'svc1',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
    ).toEqual({
      id: 'v1',
      name: 'pg-data',
      csi_driver: 'ebs.csi.aws.com',
      access_mode: 'single-writer',
      capacity_bytes: '10737418240',
      status: 'READY',
      service_id: 'svc1',
      created_at: '2026-06-01T00:00:00.000Z',
    });
  });
});

describe('mesh mappers', () => {
  const route = {
    id: 'mr1',
    kind: 'direct',
    targetServiceId: 'svc1',
    targetStackId: null,
    cidr: null,
    port: 5432,
    principalType: 'peer',
    principalId: 'peer-xyz',
    expiresAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  it('maps a mesh route', () => {
    expect(meshRouteToDto(route)).toEqual({
      id: 'mr1',
      kind: 'direct',
      target_service_id: 'svc1',
      target_stack_id: null,
      cidr: null,
      port: 5432,
      principal_type: 'peer',
      principal_id: 'peer-xyz',
      expires_at: null,
      created_at: '2026-06-01T00:00:00.000Z',
    });
  });

  it('omits setup_key when absent', () => {
    const dto = meshConnectToDto({ driver: 'netbird', address: '10.0.0.1:5432', joinSnippet: 'netbird up' });
    expect(dto).not.toHaveProperty('setup_key');
    expect(dto.join_snippet).toBe('netbird up');
  });

  it('includes setup_key when present', () => {
    const dto = meshConnectToDto({
      driver: 'netbird',
      address: '10.0.0.1:5432',
      joinSnippet: 'netbird up',
      setupKey: 'sk-123',
    });
    expect(dto.setup_key).toBe('sk-123');
  });

  it('maps the combined grant result', () => {
    const dto = grantMeshRouteToDto({
      route,
      connect: { driver: 'netbird', address: '10.0.0.1:5432', joinSnippet: 'netbird up', setupKey: 'sk-1' },
    });
    expect(dto.route.id).toBe('mr1');
    expect(dto.connect.setup_key).toBe('sk-1');
  });
});
