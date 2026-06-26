import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import type { DriverDispatch, IngressConfig, IngressDriver, IngressValidationResult } from '../types';

/**
 * The unopinionated default: swarmy writes nothing to nodes. Domains are still
 * tracked (for display) but the operator owns routing entirely.
 */
export class NoneDriver implements IngressDriver {
  readonly name = 'none';

  validate(): IngressValidationResult {
    return { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    return {
      driver: 'none',
      files: [],
      serviceLabels: [],
      summary: `Ingress unmanaged — you control routing. Tracking ${config.domains.length} domain(s) for display only.`,
    };
  }

  async apply(
    _rendered: RenderedConfig,
    _dispatch: DriverDispatch,
    config: IngressConfig,
  ): Promise<IngressStatus> {
    return {
      driver: 'none',
      healthy: true,
      activeDomains: config.domains.map((d) => d.domain),
      certs: [],
      message: 'unmanaged',
    };
  }

  async status(config: IngressConfig): Promise<IngressStatus> {
    return {
      driver: 'none',
      healthy: true,
      activeDomains: config.domains.map((d) => d.domain),
      certs: [],
      message: 'unmanaged',
    };
  }
}
