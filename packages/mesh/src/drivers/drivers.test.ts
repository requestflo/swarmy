import { describe, expect, test } from 'bun:test';
import { MeshEnrollment } from '@swarmy/core/protocol';
import type { DriverControlPlane, MeshConfig } from '../types';
import { NetbirdDriver } from './netbird';
import { HeadscaleDriver } from './headscale';
import { TailscaleDriver } from './tailscale';
import { WireguardDriver } from './wireguard';
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
  test('registers all five drivers; none stays available as default', () => {
    expect(defaultRegistry.list().sort()).toEqual(
      ['headscale', 'netbird', 'none', 'tailscale', 'wireguard'].sort(),
    );
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
    expect(rendered.client?.image).toBe('netbirdio/netbird:latest');
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

describe('TailscaleDriver', () => {
  test('validate requires an auth key in the vault', () => {
    const d = new TailscaleDriver();
    expect(d.validate(cfg('tailscale')).ok).toBe(false);
    const ok = d.validate(
      cfg('tailscale', { controlPlane: { mode: 'external', serviceToken: 'tskey-abc' } }),
    );
    expect(ok.ok).toBe(true);
  });

  test('render carries tailnet + relayed status', async () => {
    const d = new TailscaleDriver();
    const config = cfg('tailscale', {
      controlPlane: { mode: 'external', serviceToken: 'tskey-abc' },
      settings: { tailnet: 'example.com' },
    });
    const enr = MeshEnrollment.parse(await d.provisionNode(config, { nodeId: 'n1' }, fakeControl));
    const rendered = d.render(config, enr);
    expect(rendered.client?.tailnet).toBe('example.com');
    expect(rendered.driver).toBe('tailscale');
  });
});

describe('WireguardDriver render (golden conf)', () => {
  test('mints a keypair, allocates an address, renders wg0.conf', async () => {
    const d = new WireguardDriver();
    const config = cfg('wireguard', {
      managementUrl: undefined,
      controlPlane: { mode: 'external' },
      settings: {
        subnet: '10.77.0.0/24',
        nextAddress: '10.77.0.5/24',
        listenPort: 51820,
        peers: [
          {
            publicKey: 'PEER_PUBKEY_AAA',
            endpoint: '203.0.113.1:51820',
            allowedIps: ['10.77.0.1/32'],
            persistentKeepalive: 25,
          },
        ],
      },
    });
    expect(d.validate(config).ok).toBe(true);
    const enr = MeshEnrollment.parse(await d.provisionNode(config, { nodeId: 'n1' }, fakeControl));
    expect(enr.wireguard?.privateKey).toBeTruthy();
    const rendered = d.render(config, enr);
    expect(rendered.files).toHaveLength(1);
    expect(rendered.reloadCommand).toEqual(['wg-quick', 'up', 'wg0']);
    const conf = rendered.files[0]!.contents;
    expect(conf).toContain('[Interface]');
    expect(conf).toContain('Address = 10.77.0.5/24');
    expect(conf).toContain('ListenPort = 51820');
    expect(conf).toContain('[Peer]');
    expect(conf).toContain('PublicKey = PEER_PUBKEY_AAA');
    expect(conf).toContain('Endpoint = 203.0.113.1:51820');
    expect(conf).toContain('AllowedIPs = 10.77.0.1/32');
    expect(conf).toContain('PersistentKeepalive = 25');
  });

  test('validate fails without a subnet', () => {
    const d = new WireguardDriver();
    expect(d.validate(cfg('wireguard', { settings: {} })).ok).toBe(false);
  });
});
