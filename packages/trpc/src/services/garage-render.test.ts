import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_GARAGE_IMAGE,
  GARAGE_S3_PORT,
  renderGarageDeployment,
  renderGarageToml,
  renderLayoutBody,
  GARAGE_CONFIG_PATH,
  GARAGE_MEMBER_NODE_LABEL,
  GARAGE_NETWORK,
  garageAdminUrl,
  effectiveReplicationFactor,
  garageConfigObject,
  type GarageRenderInput,
} from './garage-render';

const BASE: GarageRenderInput = {
  orgId: 'org_123',
  serviceName: 'swarmy-garage',
  region: 'swarmy',
  replicationFactor: 3,
  rpcSecret: 'deadbeef'.repeat(8),
  adminToken: 'admintoken123',
  members: [
    { nodeId: 'node_a', rpcHost: 'swarmy-garage', capacityGb: 100 },
    { nodeId: 'node_b', rpcHost: 'swarmy-garage', capacityGb: 100 },
  ],
};

describe('garage config render', () => {
  it('renders a deterministic garage.toml (golden)', () => {
    const toml = renderGarageToml(BASE);
    expect(toml).toContain('replication_factor = 3');
    expect(toml).toContain(`rpc_secret = "${BASE.rpcSecret}"`);
    expect(toml).toContain(`api_bind_addr = "[::]:${GARAGE_S3_PORT}"`);
    expect(toml).toContain('s3_region = "swarmy"');
    expect(toml).toContain(`admin_token = "${BASE.adminToken}"`);
    // stable across calls
    expect(renderGarageToml(BASE)).toBe(toml);
  });

  it('omits the layout admin call until members have joined', () => {
    const r = renderGarageDeployment(BASE);
    expect(r.adminApi).toBeUndefined();
    expect(r.driver).toBe('garage');
    expect(r.image).toBe(DEFAULT_GARAGE_IMAGE);
    // Zero host files: garage.toml rides as a swarm Docker config.
    expect(r.files).toEqual([]);
    expect(r.configs).toEqual([
      { source: garageConfigObject(BASE).name, target: GARAGE_CONFIG_PATH, mode: 0o400 },
    ]);
  });

  it('emits a layout assignment per joined member', () => {
    const input: GarageRenderInput = {
      ...BASE,
      members: [
        { nodeId: 'node_a', rpcHost: 'swarmy-garage', capacityGb: 100, garageNodeId: 'aaaa' },
        { nodeId: 'node_b', rpcHost: 'swarmy-garage', capacityGb: 50, garageNodeId: 'bbbb' },
      ],
    };
    const body = JSON.parse(renderLayoutBody(input)) as Array<{
      id: string;
      zone: string;
      capacity: number;
      tags: string[];
    }>;
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      id: 'aaaa',
      zone: 'node-node_a',
      capacity: 100_000_000_000,
      tags: ['org:org_123'],
    });
    const r = renderGarageDeployment(input);
    expect(r.adminApi?.method).toBe('POST');
    // Overlay DNS (one-shot container on the swarmy overlay), never 127.0.0.1 / a node IP.
    expect(r.adminApi?.url).toBe('http://swarmy-garage:3903/v1/layout');
    expect(r.adminApi?.bearerToken).toBe(BASE.adminToken);
  });
});

describe('garage deployment — Docker config + member pinning', () => {
  it('config name is content-addressed: stable per render, rotates on change', () => {
    const a = garageConfigObject(BASE);
    expect(a.name).toMatch(/^swarmy-garage-config-[0-9a-f]{8}$/);
    expect(garageConfigObject(BASE)).toEqual(a);
    expect(a.contents).toBe(renderGarageToml(BASE));
    expect(garageConfigObject({ ...BASE, replicationFactor: 2 }).name).not.toBe(a.name);
  });

  it('is one global service pinned to member-labelled nodes (node-local volumes)', () => {
    const r = renderGarageDeployment(BASE);
    expect(r.serviceMode).toBe('global');
    expect(r.placement).toEqual({ constraints: [`node.labels.${GARAGE_MEMBER_NODE_LABEL}==true`] });
  });
});

describe('effectiveReplicationFactor', () => {
  it('clamps to the member count and never below 1', () => {
    expect(effectiveReplicationFactor(3, 2)).toBe(2);
    expect(effectiveReplicationFactor(3, 1)).toBe(1);
    expect(effectiveReplicationFactor(3, 5)).toBe(3);
    expect(effectiveReplicationFactor(0, 2)).toBe(1);
    expect(effectiveReplicationFactor(2, 0)).toBe(1);
  });
});

describe('garage deployment — overlay-only, nothing published', () => {
  it('joins the canonical swarmy overlay (agent then publishes no ports)', () => {
    const r = renderGarageDeployment(BASE);
    expect(GARAGE_NETWORK).toBe('swarmy');
    expect(r.networks).toEqual([GARAGE_NETWORK]);
  });

  it('admin base URL is the service name on the overlay', () => {
    expect(garageAdminUrl('swarmy-garage')).toBe('http://swarmy-garage:3903/v1');
  });
});
