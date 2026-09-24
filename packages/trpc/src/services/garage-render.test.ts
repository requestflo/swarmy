import { describe, expect, it } from 'bun:test';
import { SWARMY_CONTROL_NETWORK } from '@swarmy/core';
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
  garageSecretObjects,
  isGarageSecretName,
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
    expect(toml).toContain('rpc_secret_file = "/run/secrets/garage-rpc-secret"');
    expect(toml).toContain(`api_bind_addr = "[::]:${GARAGE_S3_PORT}"`);
    expect(toml).toContain('s3_region = "swarmy"');
    expect(toml).toContain('admin_token_file = "/run/secrets/garage-admin-token"');
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
    // New stores run v2: the same assignment, in the v2 dialect.
    const r = renderGarageDeployment(input);
    expect(r.adminApi?.method).toBe('POST');
    // Overlay DNS (one-shot container on the swarmy overlay), never 127.0.0.1 / a node IP.
    expect(r.adminApi?.url).toBe('http://swarmy-garage:3903/v2/UpdateClusterLayout');
    expect(JSON.parse(r.adminApi?.body ?? "{}").roles).toEqual(body);
    expect(r.adminApi?.bearerToken).toBe(BASE.adminToken);
    // A store still on the legacy engine keeps speaking v1.
    const legacy = renderGarageDeployment({ ...input, image: 'dxflrs/garage:v1.0.1' });
    expect(legacy.adminApi?.url).toBe('http://swarmy-garage:3903/v1/layout');
    expect(JSON.parse(legacy.adminApi?.body ?? "[]")).toEqual(body);
    expect(legacy.image).toBe('dxflrs/garage:v1.0.1');
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

describe('garage secrets — Docker secrets, never inside the config', () => {
  it('garage.toml (a world-inspectable Docker config) carries NO secret material', () => {
    const cfg = garageConfigObject(BASE);
    expect(cfg.contents).not.toContain(BASE.rpcSecret);
    expect(cfg.contents).not.toContain(BASE.adminToken);
    expect(cfg.contents).not.toMatch(/^\s*(rpc_secret|admin_token|metrics_token)\s*=/m);
    // The whole render (what rides the wire as `rendered`) never embeds the rpc secret.
    expect(JSON.stringify({ ...renderGarageDeployment(BASE), adminApi: undefined })).not.toContain(BASE.rpcSecret);
  });

  it('attaches the rpc secret + admin token as content-addressed secrets at the *_file targets', () => {
    const s = garageSecretObjects(BASE);
    expect(s.rpcSecret.name).toMatch(/^swarmy-garage-rpc-secret-[0-9a-f]{8}$/);
    expect(s.adminToken.name).toMatch(/^swarmy-garage-admin-token-[0-9a-f]{8}$/);
    expect(s.rpcSecret.value).toBe(BASE.rpcSecret);
    expect(s.adminToken.value).toBe(BASE.adminToken);
    // Garage refuses world-readable secret files ⇒ 0400.
    expect(renderGarageDeployment(BASE).secrets).toEqual([
      { source: s.rpcSecret.name, target: 'garage-rpc-secret', mode: 0o400 },
      { source: s.adminToken.name, target: 'garage-admin-token', mode: 0o400 },
    ]);
  });

  it('rotation: a new secret value is a new secret name, same toml/config', () => {
    const rotated = { ...BASE, adminToken: 'rotated-token' };
    expect(garageSecretObjects(rotated).adminToken.name).not.toBe(garageSecretObjects(BASE).adminToken.name);
    expect(garageSecretObjects(rotated).rpcSecret.name).toBe(garageSecretObjects(BASE).rpcSecret.name);
    expect(garageConfigObject(rotated).name).toBe(garageConfigObject(BASE).name);
  });

  it('isGarageSecretName scopes the sweep to our prefixes', () => {
    expect(isGarageSecretName(garageSecretObjects(BASE).rpcSecret.name)).toBe(true);
    expect(isGarageSecretName(garageSecretObjects(BASE).adminToken.name)).toBe(true);
    expect(isGarageSecretName('swarmy-cache-shop_main-password')).toBe(false);
    expect(isGarageSecretName('swarmy-garage-rpc-secret')).toBe(false);
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
    expect(r.networks).toEqual([GARAGE_NETWORK, SWARMY_CONTROL_NETWORK]);
  });

  it('admin base URL is the service name on the overlay', () => {
    expect(garageAdminUrl('swarmy-garage')).toBe('http://swarmy-garage:3903/v1');
  });
});
