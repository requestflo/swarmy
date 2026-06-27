import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';
import type {
  DriverControlPlane,
  MeshAccessRender,
  MeshConfig,
  MeshDriver,
  MeshValidationResult,
  ProvisionNodeOpts,
} from '../types';

/**
 * The unopinionated default: swarmy provisions no mesh. Nodes reach each other
 * over their own routable network. This is the default driver and stays default
 * until an admin explicitly picks NetBird and enables mesh — exactly like the
 * `none` ingress driver (record intent, write nothing).
 */
export class NoneDriver implements MeshDriver {
  readonly name = 'none';

  validate(): MeshValidationResult {
    return { ok: true };
  }

  async provisionNode(
    _config: MeshConfig,
    _opts: ProvisionNodeOpts,
    _control: DriverControlPlane,
  ): Promise<MeshEnrollment> {
    return {
      driver: 'none',
      interface: 'wt0',
      advertiseRoutes: [],
      acceptRoutes: false,
    };
  }

  render(): RenderedMesh {
    return {
      driver: 'none',
      action: 'leave',
      files: [],
      summary: 'Mesh unmanaged — nodes use their own network. swarmy stays out of the way.',
    };
  }

  async status(): Promise<MeshStatus> {
    return { driver: 'none', connected: false, relayed: false, message: 'unmanaged' };
  }

  applyAccess(): MeshAccessRender {
    return { kind: 'none', summary: 'Mesh unmanaged — no ACL to apply.' };
  }
}
