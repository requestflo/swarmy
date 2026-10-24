import { describe, expect, it } from 'bun:test';
import { REGISTRY_AUTH_LABEL, registryServiceSpec } from './registry-auth';
import { pinRegistryToNode, registryMaintenanceSpec } from './registry-gc.spec';
import { registryCacheServiceSpec } from './system-images.service';

const HUB_UPSTREAM = 'https://registry-1.docker.io';

describe('registryServiceSpec topology (M16)', () => {
  it('mesh (the default) is the old spec: :5000 on the routing mesh, on swarmy', () => {
    const s = registryServiceSpec('sec');
    expect(s.ports).toEqual([{ target: 5000, published: 5000, protocol: 'tcp', mode: 'ingress' }]);
    expect(s.networks).toEqual(['swarmy']);
    expect(registryServiceSpec('sec', {}, 'mesh')).toEqual(s);
  });

  it('loopback publishes nothing (explicitly, so an update drops the mesh port) and stays on swarmy', () => {
    const s = registryServiceSpec('sec', { 'swarmy.mirror.busybox': 'busybox@sha256:1' }, 'loopback');
    expect(s.ports).toEqual([]);
    expect(s.networks).toEqual(['swarmy']);
    // Everything else is the same registry: auth, deletes, volume, mirror labels.
    expect(s.env).toMatchObject({ REGISTRY_AUTH: 'htpasswd', REGISTRY_STORAGE_DELETE_ENABLED: 'true' });
    expect(s.labels).toMatchObject({ 'swarmy.mirror.busybox': 'busybox@sha256:1', [REGISTRY_AUTH_LABEL]: 'sec' });
    expect(s.mounts).toEqual(registryServiceSpec('sec').mounts);
  });
});

describe('registryCacheServiceSpec topology (M16)', () => {
  it('mesh (the default) is the old spec: :5001 on the routing mesh, no overlay', () => {
    const s = registryCacheServiceSpec(HUB_UPSTREAM);
    expect(s.ports).toEqual([{ target: 5000, published: 5001, protocol: 'tcp', mode: 'ingress' }]);
    expect(s.networks).toBeUndefined();
  });

  it('loopback joins the encrypted swarmy overlay and publishes nothing; the Hub login is unchanged', () => {
    const auth = { username: 'me', secret: 'swarmy-registry-cache-hub-x' };
    const s = registryCacheServiceSpec(HUB_UPSTREAM, auth, 'loopback');
    expect(s.ports).toEqual([]);
    expect(s.networks).toEqual(['swarmy']);
    expect(s.labels).toEqual(registryCacheServiceSpec(HUB_UPSTREAM, auth).labels);
    expect(s.secrets).toEqual(registryCacheServiceSpec(HUB_UPSTREAM, auth).secrets);
  });
});

describe('registryMaintenanceSpec topology (the GC window never moves it by accident)', () => {
  const labels = { [REGISTRY_AUTH_LABEL]: 'swarmy-registry-htpasswd-abc', 'swarmy.mirror.node': 'n2' };
  const onMesh = { labels, ports: [{ target: 5000, published: 5000, protocol: 'tcp' as const }], networks: [{ name: 'swarmy', aliases: [] }] };
  const moved = { labels, ports: [], networks: [{ name: 'swarmy', aliases: [] }] };

  it('defaults to the live topology', () => {
    expect(registryMaintenanceSpec(onMesh, 'n2', true)?.ports).toEqual([{ target: 5000, published: 5000, protocol: 'tcp', mode: 'ingress' }]);
    expect(registryMaintenanceSpec(moved, 'n2', true)?.ports).toEqual([]);
  });

  it('the migration spec: loopback, still pinned to the volume node, stop-first, mirror labels kept', () => {
    const s = registryMaintenanceSpec(onMesh, 'n2', false, 'loopback');
    expect(s?.ports).toEqual([]);
    expect(s?.placement).toEqual({ constraints: ['node.id==n2'] });
    expect(s?.updateConfig).toEqual({ order: 'stop-first' });
    expect(s?.labels).toMatchObject({ 'swarmy.mirror.node': 'n2' });
    expect(s?.env).not.toHaveProperty('REGISTRY_STORAGE_MAINTENANCE_READONLY');
  });
});

describe('pinRegistryToNode', () => {
  it('pins to a swarm node id; anything else leaves the spec alone', () => {
    const s = registryServiceSpec('sec');
    expect(pinRegistryToNode(s, 'abc123')).toMatchObject({ placement: { constraints: ['node.id==abc123'] }, updateConfig: { order: 'stop-first' } });
    expect(pinRegistryToNode(s, null)).toBe(s);
    expect(pinRegistryToNode(s, 'x || node.role==manager')).toBe(s);
  });
});
