import { describe, expect, test } from 'bun:test';
import { MeshEnrollment } from '@swarmy/core/protocol';
import type { DriverControlPlane, MeshConfig } from '../types';
import { NetbirdDriver } from './netbird';
import { NETBIRD_CLIENT_IMAGE_PINNED } from '../images';
import { HeadscaleDriver } from './headscale';
import { defaultRegistry } from '../registry';

const fakeControl: DriverControlPlane = {
  async createSetupKey() {
    return { setupKey: 'KEY-123' };
  },
  async listPeers() {
    return [{ peerId: 'p1', connected: true, meshIp: '100.64.0.2' }];
  },
  async revokePeer() {},
};

function cfg(driver: string, extra: Partial<MeshConfig> = {}): MeshConfig {
  return {
    driver,
    enabled: true,
    orgId: 'org_1',
    managementUrl: 'https://netbird.example.com',
    controlPlane: { mode: 'external', url: 'https://netbird.example.com' },
    settings: {},
    ...extra,
  };
}

describe('registry', () => {
  test('registers netbird, headscale and none; none stays available as default', () => {
    expect(defaultRegistry.list().sort()).toEqual(['headscale', 'netbird', 'none']);
    expect(defaultRegistry.has('none')).toBe(true);
  });
});

describe('NetbirdDriver render', () => {
  test('renders a netbird client join (golden)', async () => {
    const d = new NetbirdDriver();
    const enr = MeshEnrollment.parse(
      await d.provisionNode(cfg('netbird'), { nodeId: 'n1', advertiseRoutes: ['10.0.0.0/24'] }, fakeControl),
    );
    const rendered = d.render(cfg('netbird'), enr);
    expect(rendered.driver).toBe('netbird');
    expect(rendered.client?.kind).toBe('netbird');
    expect(rendered.client?.setupKey).toBe('KEY-123');
    expect(rendered.client?.advertiseRoutes).toEqual(['10.0.0.0/24']);
    expect(rendered.client?.image).toBe(NETBIRD_CLIENT_IMAGE_PINNED);
  });
});

describe('HeadscaleDriver render', () => {
  test('uses the tailscale client + auth key', async () => {
    const d = new HeadscaleDriver();
    const enr = MeshEnrollment.parse(
      await d.provisionNode(cfg('headscale'), { nodeId: 'n1' }, fakeControl),
    );
    const rendered = d.render(cfg('headscale'), enr);
    expect(rendered.client?.kind).toBe('tailscale');
    expect(rendered.client?.authKey).toBe('KEY-123');
    expect(rendered.client?.interface).toBe('tailscale0');
  });
});

