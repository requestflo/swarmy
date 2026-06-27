import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';
import type {
  DriverControlPlane,
  MeshAccessRender,
  MeshConfig,
  MeshDriver,
  MeshValidationResult,
  ProvisionNodeOpts,
} from '../types';
import { buildHeadscaleAcl, type MeshAccessIntent } from '../acl';

/** Headscale uses the official Tailscale client; default tailscale interface. */
export const HEADSCALE_INTERFACE = 'tailscale0';
export const HEADSCALE_CLIENT_IMAGE = 'tailscale/tailscale:latest';
export const HEADSCALE_ACL_PATH = '/etc/headscale/acl.hujson';

/**
 * Headscale driver — a self-hosted reimplementation of the Tailscale control
 * plane. Nodes run the official Tailscale client pointed at the Headscale
 * `--login-server`, authenticating with a pre-auth key minted control-plane-side
 * (`headscale preauthkeys create`, surfaced here via {@link DriverControlPlane}).
 * Access is config-as-code: a single HuJSON ACL file (see {@link applyAccess}).
 */
export class HeadscaleDriver implements MeshDriver {
  readonly name = 'headscale';

  validate(config: MeshConfig): MeshValidationResult {
    const errors: { path: string; message: string }[] = [];
    if (!config.managementUrl && !config.controlPlane.url) {
      errors.push({
        path: 'managementUrl',
        message: 'Headscale requires a login-server URL',
      });
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  async provisionNode(
    config: MeshConfig,
    opts: ProvisionNodeOpts,
    control: DriverControlPlane,
  ): Promise<MeshEnrollment> {
    const { setupKey } = await control.createSetupKey({ nodeId: opts.nodeId });
    return {
      driver: 'headscale',
      managementUrl: config.managementUrl ?? config.controlPlane.url,
      authKey: setupKey,
      interface: HEADSCALE_INTERFACE,
      advertiseRoutes: opts.advertiseRoutes ?? [],
      acceptRoutes: true,
    };
  }

  render(config: MeshConfig, enrollment: MeshEnrollment): RenderedMesh {
    const image = (config.settings.clientImage as string) ?? HEADSCALE_CLIENT_IMAGE;
    return {
      driver: 'headscale',
      action: 'join',
      client: {
        kind: 'tailscale',
        image,
        managementUrl: enrollment.managementUrl,
        authKey: enrollment.authKey,
        interface: enrollment.interface ?? HEADSCALE_INTERFACE,
        advertiseRoutes: enrollment.advertiseRoutes,
        acceptRoutes: enrollment.acceptRoutes,
      },
      files: [],
      summary: `Join Headscale mesh via ${enrollment.managementUrl ?? '(no URL)'} (tailscale client)${
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
        driver: 'headscale',
        connected: peers.some((p) => p.connected),
        relayed: false,
        message: `${peers.filter((p) => p.connected).length}/${peers.length} peers connected`,
      };
    } catch (e) {
      return {
        driver: 'headscale',
        connected: false,
        relayed: false,
        message: e instanceof Error ? e.message : 'control plane unreachable',
      };
    }
  }

  applyAccess(_config: MeshConfig, intent: MeshAccessIntent): MeshAccessRender {
    return { kind: 'file', path: HEADSCALE_ACL_PATH, contents: buildHeadscaleAcl(intent) };
  }
}
