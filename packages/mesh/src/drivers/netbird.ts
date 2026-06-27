import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';
import type {
  DriverControlPlane,
  MeshAccessRender,
  MeshConfig,
  MeshDriver,
  MeshValidationResult,
  ProvisionNodeOpts,
} from '../types';
import { buildNetbirdPolicyPlan, type MeshAccessIntent } from '../acl';

/** Default NetBird client image. Pin a digest in production. */
export const NETBIRD_CLIENT_IMAGE = 'netbirdio/netbird:latest';
/** Default WireGuard interface the NetBird client creates. */
export const NETBIRD_INTERFACE = 'wt0';

/**
 * NetBird driver (the MVP default once mesh is enabled). WireGuard data plane
 * with a self-hostable or external control plane. Like the Cloudflared ingress
 * driver, the NetBird *Admin API* calls (mint setup key, list/revoke peers) are
 * control-plane-side via {@link DriverControlPlane}; the driver itself stays
 * pure and only renders what the agent applies (run/join the client container).
 */
export class NetbirdDriver implements MeshDriver {
  readonly name = 'netbird';

  validate(config: MeshConfig): MeshValidationResult {
    const errors: { path: string; message: string }[] = [];
    if (!config.managementUrl && !config.controlPlane.url) {
      errors.push({
        path: 'managementUrl',
        message: 'NetBird requires a management URL (managed-by-swarmy or external)',
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
      driver: 'netbird',
      managementUrl: config.managementUrl ?? config.controlPlane.url,
      setupKey,
      interface: NETBIRD_INTERFACE,
      advertiseRoutes: opts.advertiseRoutes ?? [],
      acceptRoutes: true,
    };
  }

  render(config: MeshConfig, enrollment: MeshEnrollment): RenderedMesh {
    const image = (config.settings.clientImage as string) ?? NETBIRD_CLIENT_IMAGE;
    return {
      driver: 'netbird',
      action: 'join',
      client: {
        kind: 'netbird',
        image,
        managementUrl: enrollment.managementUrl,
        setupKey: enrollment.setupKey,
        interface: enrollment.interface ?? NETBIRD_INTERFACE,
        advertiseRoutes: enrollment.advertiseRoutes,
        acceptRoutes: enrollment.acceptRoutes,
      },
      files: [],
      summary: `Join NetBird mesh via ${enrollment.managementUrl ?? '(no URL)'} on ${
        enrollment.interface ?? NETBIRD_INTERFACE
      }${
        enrollment.advertiseRoutes.length
          ? `, advertising ${enrollment.advertiseRoutes.join(', ')}`
          : ''
      }.`,
    };
  }

  async status(_config: MeshConfig, control: DriverControlPlane): Promise<MeshStatus> {
    try {
      const peers = await control.listPeers();
      const connected = peers.some((p) => p.connected);
      return {
        driver: 'netbird',
        connected,
        relayed: false,
        message: `${peers.filter((p) => p.connected).length}/${peers.length} peers connected`,
      };
    } catch (e) {
      return {
        driver: 'netbird',
        connected: false,
        relayed: false,
        message: e instanceof Error ? e.message : 'control plane unreachable',
      };
    }
  }

  applyAccess(_config: MeshConfig, intent: MeshAccessIntent): MeshAccessRender {
    return { kind: 'control-plane', plan: buildNetbirdPolicyPlan(intent) };
  }
}
