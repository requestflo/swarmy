import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_GARAGE_IMAGE,
  GARAGE_S3_PORT,
  renderGarageDeployment,
  renderGarageToml,
  renderLayoutBody,
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
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.path).toContain('garage.toml');
    expect(r.files[0]!.mode).toBe(0o600);
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
    expect(r.adminApi?.url).toContain('/v1/layout');
    expect(r.adminApi?.bearerToken).toBe(BASE.adminToken);
  });
});
