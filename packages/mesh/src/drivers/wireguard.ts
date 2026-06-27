import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';
import type {
  DriverControlPlane,
  MeshAccessRender,
  MeshConfig,
  MeshDriver,
  MeshValidationResult,
  ProvisionNodeOpts,
} from '../types';
import type { MeshAccessIntent } from '../acl';
import {
  renderWireguardConfig,
  WIREGUARD_CONFIG_PATH,
  WIREGUARD_DEFAULT_PORT,
  WIREGUARD_INTERFACE,
  type WireguardPeer,
} from '../render/wireguard';
import { generateWireguardKeypair } from '../render/keygen';

/**
 * Raw WireGuard driver — maximum control, no control plane. swarmy mints a
 * keypair per node (control-plane-side, here via {@link generateWireguardKeypair}),
 * assigns a mesh address, and renders a `wg0.conf` the agent writes + brings up
 * with `wg-quick`. There is NO NAT traversal / relay — "you own routing/NAT",
 * the mesh analog of the `none` ingress driver's "you own DNS". Peers are
 * supplied via `config.settings.peers` (the controller maintains the peer list).
 */
export class WireguardDriver implements MeshDriver {
  readonly name = 'wireguard';

  validate(config: MeshConfig): MeshValidationResult {
    const errors: { path: string; message: string }[] = [];
    const subnet = config.settings.subnet as string | undefined;
    if (!subnet) {
      errors.push({
        path: 'settings.subnet',
        message: 'raw WireGuard requires a mesh subnet (e.g. 10.77.0.0/24) to allocate node addresses',
      });
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  async provisionNode(
    config: MeshConfig,
    opts: ProvisionNodeOpts,
    _control: DriverControlPlane,
  ): Promise<MeshEnrollment> {
    const keypair = generateWireguardKeypair();
    const address =
      (opts as { meshAddress?: string }).meshAddress ??
      (config.settings.nextAddress as string | undefined) ??
      '10.77.0.2/24';
    const peers = ((config.settings.peers as WireguardPeer[] | undefined) ?? []).map((p) => ({
      publicKey: p.publicKey,
      endpoint: p.endpoint,
      allowedIps: p.allowedIps ?? [],
      persistentKeepalive: p.persistentKeepalive,
    }));
    return {
      driver: 'wireguard',
      interface: WIREGUARD_INTERFACE,
      wireguard: {
        address,
        privateKey: keypair.privateKey,
        listenPort: (config.settings.listenPort as number) ?? WIREGUARD_DEFAULT_PORT,
        dns: (config.settings.dns as string[]) ?? [],
        peers,
      },
      advertiseRoutes: opts.advertiseRoutes ?? [],
      acceptRoutes: true,
    };
  }

  render(_config: MeshConfig, enrollment: MeshEnrollment): RenderedMesh {
    const wg = enrollment.wireguard;
    if (!wg) {
      return {
        driver: 'wireguard',
        action: 'leave',
        files: [],
        reloadCommand: ['wg-quick', 'down', WIREGUARD_INTERFACE],
        summary: 'Tear down WireGuard interface.',
      };
    }
    const contents = renderWireguardConfig({
      address: wg.address,
      privateKey: wg.privateKey,
      listenPort: wg.listenPort,
      dns: wg.dns,
      peers: wg.peers,
    });
    return {
      driver: 'wireguard',
      action: 'join',
      files: [{ path: WIREGUARD_CONFIG_PATH, contents, mode: 0o600 }],
      reloadCommand: ['wg-quick', 'up', WIREGUARD_INTERFACE],
      summary: `Write ${WIREGUARD_CONFIG_PATH} (${wg.peers.length} peer${
        wg.peers.length === 1 ? '' : 's'
      }) and bring up ${WIREGUARD_INTERFACE} at ${wg.address}.`,
    };
  }

  async status(): Promise<MeshStatus> {
    // No control plane — liveness comes from the agent's `meshState` (wg show).
    return {
      driver: 'wireguard',
      connected: false,
      relayed: false,
      message: 'liveness reported by agent (wg show) — no control plane',
    };
  }

  /**
   * No control plane: direct-connect is gated node-locally via the rendered
   * peer's AllowedIPs (and an agent `grantDirectRoute` for iptables). We render
   * the principal→target allowance as a per-peer AllowedIPs snippet the agent
   * appends to wg0.conf.
   */
  applyAccess(_config: MeshConfig, intent: MeshAccessIntent): MeshAccessRender {
    const lines = intent.grants.map(
      (g) => `# ${g.id}: ${g.principalTag} -> ${g.targetTag} ports ${g.ports.join(',') || '*'}`,
    );
    return {
      kind: 'file',
      path: '/etc/wireguard/swarmy-acl.txt',
      contents: lines.join('\n') + '\n',
    };
  }
}
