import type { IngressStatus, RenderedConfig } from '@swarmy/core/protocol';
import { IngressConfigSchema, type DriverDispatch, type IngressConfig } from './types';
import { defaultRegistry, IngressRegistry } from './registry';
import { IngressValidationError } from './errors';

/** Render only, no IO — backs the tRPC `ingress.previewConfig` query. */
export function previewConfig(
  config: IngressConfig,
  registry: IngressRegistry = defaultRegistry,
): RenderedConfig {
  const parsed = IngressConfigSchema.parse(config);
  const driver = registry.get(parsed.driver);
  const validation = driver.validate(parsed);
  if (!validation.ok) throw new IngressValidationError(validation.errors);
  return driver.render(parsed);
}

/** Render + dispatch to node agent(s) — backs the tRPC `ingress` apply flow. */
export async function applyIngress(
  config: IngressConfig,
  dispatch: DriverDispatch,
  registry: IngressRegistry = defaultRegistry,
): Promise<IngressStatus> {
  const parsed = IngressConfigSchema.parse(config);
  const driver = registry.get(parsed.driver);

  // Global kill-switch: write nothing, regardless of driver.
  if (!parsed.enabled) {
    return {
      driver: parsed.driver,
      healthy: true,
      activeDomains: [],
      certs: [],
      message: 'ingress disabled (enabled=false)',
    };
  }

  const validation = driver.validate(parsed);
  if (!validation.ok) throw new IngressValidationError(validation.errors);
  const rendered = driver.render(parsed);
  return driver.apply(rendered, dispatch, parsed);
}
