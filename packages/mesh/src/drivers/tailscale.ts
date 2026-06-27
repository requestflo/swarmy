import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';
import type {
  DriverControlPlane,
  MeshConfig,
  MeshDriver,
  MeshValidationResult,
  ProvisionNodeOpts,
} from '../types';

export const TAILSCALE_INTERFACE = 'tailscale0';
export const TAILSCALE_CLIENT_IMAGE = 'tailscale/tailscale:latest';
export const TAILSCALE_DEFAULT_LOGIN_SERVER = 'https://controlplane.tailscale.com';

/**
 * Tailscale (SaaS control plane) driver. For users who already live in
 * Tailscale: swarmy supplies an auth key + tailnet and the node joins via the
 * official client. The coordination plane is Tailscale's hosted SaaS, so there
 * is no self-hosted Admin API to drive — swarmy is config-light here. Access
 * (ACL grants) is delegated to the Tailscale admin console / API by the operator;
 * `applyAccess` is intentionally absent (no file/plan to render on-node).
 */
export class TailscaleDriver implements MeshDriver {
  readonly name = 'tailscale';

  validate(config: MeshConfig): MeshValidationResult {
    const errors: { path: string; message: string }[] = [];
    // An auth key is resolved JIT from the vault; presence of a configured token
    // (controlPlane.serviceToken) is the signal one exists.
    if (!config.controlPlane.serviceToken) {
      errors.push({
        path: 'controlPlane.serviceToken',
        message: 'Tailscale requires an auth key (stored encrypted in the vault)',
      });
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  async provisionNode(
    config: MeshConfig,
    opts: ProvisionNodeOpts,
    control: DriverControlPlane,
  ): Promise<MeshEnrollment> {
    // For SaaS Tailscale we may mint an ephemeral key via the API; otherwise the
    // configured reusable auth key is used directly (createSetupKey returns it).
    const { setupKey } = await control.createSetupKey({ nodeId: opts.nodeId, ephemeral: true });
    return {
      driver: 'tailscale',
      managementUrl: config.managementUrl ?? TAILSCALE_DEFAULT_LOGIN_SERVER,
      authKey: setupKey,
      tailnet: (config.settings.tailnet as string) ?? undefined,
      interface: TAILSCALE_INTERFACE,
      advertiseRoutes: opts.advertiseRoutes ?? [],
      acceptRoutes: true,
    };
  }

  render(config: MeshConfig, enrollment: MeshEnrollment): RenderedMesh {
    const image = (config.settings.clientImage as string) ?? TAILSCALE_CLIENT_IMAGE;
    return {
      driver: 'tailscale',
      action: 'join',
      client: {
        kind: 'tailscale',
        image,
        managementUrl: enrollment.managementUrl,
        authKey: enrollment.authKey,
        tailnet: enrollment.tailnet,
        interface: enrollment.interface ?? TAILSCALE_INTERFACE,
        advertiseRoutes: enrollment.advertiseRoutes,
        acceptRoutes: enrollment.acceptRoutes,
      },
      files: [],
      summary: `Join Tailscale tailnet ${enrollment.tailnet ?? '(default)'} via the official client${
        enrollment.advertiseRoutes.length
          ? `, advertising ${enrollment.advertiseRoutes.join(', ')}`
          : ''
      }.`,
    };
  }

  async status(_config: MeshConfig, control: DriverControlPlane): Promise<MeshStatus> {
    try {
      const peers = await control.listPeers();
      return {
        driver: 'tailscale',
        connected: peers.some((p) => p.connected),
        relayed: true,
        message: `${peers.filter((p) => p.connected).length}/${peers.length} peers connected (DERP-relayed)`,
      };
    } catch (e) {
      return {
        driver: 'tailscale',
        connected: false,
        relayed: true,
        message: e instanceof Error ? e.message : 'tailnet status unavailable',
      };
    }
  }
}
