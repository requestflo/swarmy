import type { IngressStatus, RenderedConfig, ServiceLabels } from '@swarmy/core/protocol';
import type {
  DriverDispatch,
  IngressConfig,
  IngressDriver,
  IngressValidationResult,
} from '../types';
import { buildTraefikDynamicYaml, buildTraefikLabels } from '../render/traefik-labels';
import { IngressApplyError } from '../errors';

export class TraefikDriver implements IngressDriver {
  readonly name = 'traefik';

  private provider(config: IngressConfig): 'labels' | 'file' {
    const p = (config.globalOptions.extraConfig as Record<string, unknown>).provider;
    return p === 'file' ? 'file' : 'labels';
  }

  validate(config: IngressConfig): IngressValidationResult {
    const errors: { path: string; message: string }[] = [];
    if (this.provider(config) === 'labels') {
      config.domains.forEach((r, i) => {
        if (r.service.includes(':')) {
          errors.push({
            path: `domains[${i}].service`,
            message: 'labels provider requires a swarm service name, not host:port',
          });
        }
      });
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  }

  render(config: IngressConfig): RenderedConfig {
    if (this.provider(config) === 'file') {
      return {
        driver: 'traefik',
        files: [
          {
            path: '/etc/traefik/dynamic/swarmy.yml',
            contents: buildTraefikDynamicYaml(config),
            mode: 0o644,
          },
        ],
        serviceLabels: [],
        summary: `Traefik (file) — ${config.domains.length} route(s)`,
      };
    }
    const labelMap = buildTraefikLabels(config);
    const serviceLabels: ServiceLabels[] = [...labelMap.entries()].map(([service, labels]) => ({
      service,
      labels,
      removeLabelKeys: [],
    }));
    return {
      driver: 'traefik',
      files: [],
      serviceLabels,
      summary: `Traefik (labels) — ${serviceLabels.length} service(s), ${config.domains.length} route(s)`,
    };
  }

  async apply(
    rendered: RenderedConfig,
    dispatch: DriverDispatch,
    config: IngressConfig,
  ): Promise<IngressStatus> {
    const nodes = await dispatch.resolveTargetNodes(config.orgId, config.targetNodes);
    const reports = await Promise.all(nodes.map((n) => dispatch.sendToNode(n, rendered)));
    const failed = reports.find((r) => !r.ok);
    if (failed) throw new IngressApplyError(failed.nodeId, failed.message ?? 'apply failed');
    return {
      driver: 'traefik',
      healthy: true,
      activeDomains: config.domains.map((d) => d.domain),
      certs: [],
      lastAppliedAt: new Date().toISOString(),
      message: `applied to ${nodes.length} node(s)`,
    };
  }

  async status(config: IngressConfig, dispatch: DriverDispatch): Promise<IngressStatus> {
    const nodes = await dispatch.resolveTargetNodes(config.orgId, config.targetNodes);
    const first = nodes[0];
    if (!first) {
      return {
        driver: 'traefik',
        healthy: false,
        activeDomains: [],
        certs: [],
        message: 'no ingress nodes',
      };
    }
    return dispatch.queryStatus(first, 'traefik');
  }
}
