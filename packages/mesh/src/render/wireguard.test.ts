import { describe, expect, test } from 'bun:test';
import { renderWireguardConfig } from './wireguard';
import { generateWireguardKeypair, publicKeyFromPrivate } from './keygen';

describe('renderWireguardConfig', () => {
  test('exact golden for a two-peer interface', () => {
    const out = renderWireguardConfig({
      address: '10.77.0.2/24',
      privateKey: 'PRIVATE_KEY_BASE64',
      listenPort: 51820,
      dns: ['10.77.0.1'],
      peers: [
        {
          name: 'hub',
          publicKey: 'HUB_PUBKEY',
          endpoint: '203.0.113.1:51820',
          allowedIps: ['10.77.0.0/24'],
          persistentKeepalive: 25,
        },
        {
          name: 'worker-b',
          publicKey: 'WORKER_PUBKEY',
          allowedIps: ['10.77.0.3/32'],
        },
      ],
    });
    expect(out).toBe(
      [
        '[Interface]',
        'Address = 10.77.0.2/24',
        'PrivateKey = PRIVATE_KEY_BASE64',
        'ListenPort = 51820',
        'DNS = 10.77.0.1',
        '',
        '# hub',
        '[Peer]',
        'PublicKey = HUB_PUBKEY',
        'AllowedIPs = 10.77.0.0/24',
        'Endpoint = 203.0.113.1:51820',
        'PersistentKeepalive = 25',
        '',
        '# worker-b',
        '[Peer]',
        'PublicKey = WORKER_PUBKEY',
        'AllowedIPs = 10.77.0.3/32',
        '',
      ].join('\n'),
    );
  });

  test('defaults the listen port and omits empty DNS', () => {
    const out = renderWireguardConfig({
      address: '10.77.0.9/24',
      privateKey: 'PK',
      peers: [],
    });
    expect(out).toContain('ListenPort = 51820');
    expect(out).not.toContain('DNS =');
  });
});

describe('keygen', () => {
  test('generates a base64 X25519 keypair whose public key is derivable', () => {
    const kp = generateWireguardKeypair();
    expect(Buffer.from(kp.privateKey, 'base64')).toHaveLength(32);
    expect(Buffer.from(kp.publicKey, 'base64')).toHaveLength(32);
    expect(publicKeyFromPrivate(kp.privateKey)).toBe(kp.publicKey);
  });
});
