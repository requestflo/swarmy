import type { MeshEnrollment, MeshStatus, RenderedMesh } from '@swarmy/core/protocol';
import {
  MeshConfigSchema,
  type DriverControlPlane,
  type MeshConfig,
  type ProvisionNodeOpts,
} from './types';
import { defaultRegistry, MeshRegistry } from './registry';
import { MeshValidationError } from './errors';

/** Provision a node + render what the agent should apply (no agent IO here). */
export async function provisionNode(
  config: MeshConfig,
  opts: ProvisionNodeOpts,
  control: DriverControlPlane,
  registry: MeshRegistry = defaultRegistry,
): Promise<{ enrollment: MeshEnrollment; rendered: RenderedMesh }> {
  const parsed = MeshConfigSchema.parse(config);
  const driver = registry.get(parsed.driver);
  const validation = driver.validate(parsed);
  if (!validation.ok) throw new MeshValidationError(validation.errors);
  const enrollment = await driver.provisionNode(parsed, opts, control);
  const rendered = driver.render(parsed, enrollment);
  return { enrollment, rendered };
}

/** Render only, no IO — backs a previewable enrollment for the Networking UI. */
export function previewMesh(
  config: MeshConfig,
  enrollment: MeshEnrollment,
  registry: MeshRegistry = defaultRegistry,
): RenderedMesh {
  const parsed = MeshConfigSchema.parse(config);
  return registry.get(parsed.driver).render(parsed, enrollment);
}

export async function meshStatus(
  config: MeshConfig,
  control: DriverControlPlane,
  registry: MeshRegistry = defaultRegistry,
): Promise<MeshStatus> {
  const parsed = MeshConfigSchema.parse(config);
  return registry.get(parsed.driver).status(parsed, control);
}
