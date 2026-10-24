import { describe, expect, it } from 'bun:test';
import { REGISTRY_AUTH_LABEL } from './registry-auth';
import { registryDataVolume, registryIsReadOnly, registryMaintenanceSpec } from './registry-gc.spec';

const live = {
  labels: { [REGISTRY_AUTH_LABEL]: 'swarmy-registry-htpasswd-abc', 'swarmy.mirror.busybox': 'busybox@sha256:1', 'swarmy.mirror.node': 'n2' },
  env: ['REGISTRY_AUTH=htpasswd'],
  mounts: [{ type: 'volume', source: 'swarmy-registry-data', target: '/var/lib/registry' }],
};

describe('registryMaintenanceSpec (registry:2 read-only GC window)', () => {
  it('read-only: env + label, pinned to the volume node, old task stopped first', () => {
    const spec = registryMaintenanceSpec(live, 'n2', true);
    expect(spec?.env).toMatchObject({ REGISTRY_AUTH: 'htpasswd', REGISTRY_STORAGE_MAINTENANCE_READONLY: '{"enabled":true}' });
    expect(spec?.labels).toMatchObject({ 'swarmy.registry.maintenance': 'gc', 'swarmy.mirror.node': 'n2', [REGISTRY_AUTH_LABEL]: 'swarmy-registry-htpasswd-abc' });
    expect(spec?.placement).toEqual({ constraints: ['node.id==n2'] });
    expect(spec?.updateConfig).toEqual({ order: 'stop-first' });
    expect(spec?.secrets?.[0]?.source).toBe('swarmy-registry-htpasswd-abc');
  });

  it('read-write: no maintenance env/label, still pinned to its data', () => {
    const spec = registryMaintenanceSpec(live, 'n2', false);
    expect(spec?.env).not.toHaveProperty('REGISTRY_STORAGE_MAINTENANCE_READONLY');
    expect(spec?.labels).not.toHaveProperty('swarmy.registry.maintenance');
    expect(spec?.placement).toEqual({ constraints: ['node.id==n2'] });
  });

  it('refuses without a login to carry, or with a node id that is not a swarm id', () => {
    expect(registryMaintenanceSpec({ labels: {} }, 'n2', true)).toBeNull();
    expect(registryMaintenanceSpec(live, 'n2 || node.role==manager', true)).toBeNull();
  });
});

describe('registryIsReadOnly / registryDataVolume', () => {
  it('spots an interrupted window by env or label', () => {
    expect(registryIsReadOnly(live)).toBe(false);
    expect(registryIsReadOnly({ ...live, env: ['REGISTRY_STORAGE_MAINTENANCE_READONLY={"enabled":true}'] })).toBe(true);
    expect(registryIsReadOnly({ ...live, labels: { 'swarmy.registry.maintenance': 'gc' } })).toBe(true);
  });

  it('runs only against a local filesystem volume', () => {
    expect(registryDataVolume(live)).toBe('swarmy-registry-data');
    expect(registryDataVolume({ ...live, mounts: undefined })).toBe('swarmy-registry-data');
    expect(registryDataVolume({ ...live, env: ['REGISTRY_STORAGE=s3'] })).toBeNull();
    expect(registryDataVolume({ ...live, mounts: [{ type: 'bind', source: '/srv/reg', target: '/var/lib/registry' }] })).toBeNull();
  });
});
