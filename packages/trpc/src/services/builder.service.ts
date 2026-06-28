import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  composeToModels,
  modelsToCompose,
  modelToServiceSpec,
  ServiceModel,
  validateModel,
  type ServiceModelOut,
  type ServiceSpecLike,
  type TranslationWarning,
} from '@swarmy/core/compose';
import { writeAudit } from '../services/audit.service';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { liveService } from './service.service';

/**
 * Compose import/export for the GUI service builder. The `yaml` string <-> object
 * boundary lives here (the controller has the lib); the pure model translation
 * lives in `@swarmy/core/compose`.
 */

export interface ParseComposeResult {
  models: ServiceModelOut[];
  warnings: TranslationWarning[];
  /** A structural parse error (invalid YAML), if any. */
  parseError?: string;
}

export async function parseCompose(
  ctx: OrgContext,
  source: string,
): Promise<ParseComposeResult> {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    return { models: [], warnings: [], parseError: (e as Error).message };
  }
  if (!doc || typeof doc !== 'object') {
    return { models: [], warnings: [], parseError: 'compose document is empty or not an object' };
  }
  const { models, warnings } = composeToModels(doc as { services?: Record<string, unknown> });
  await writeAudit(ctx, {
    action: 'service.builder.import',
    targetType: 'compose',
    metadata: { serviceCount: models.length, warningCount: warnings.length },
  });
  return { models, warnings };
}

/** ServiceModel[] -> compose YAML string. Validates each model first. */
export async function exportCompose(
  ctx: OrgContext,
  models: unknown[],
): Promise<{ yaml: string }> {
  const parsed = models.map((m) => ServiceModel.parse(m));
  const obj = modelsToCompose(parsed);
  const yaml = stringifyYaml(obj, { lineWidth: 0 });
  await writeAudit(ctx, {
    action: 'service.builder.export',
    targetType: 'compose',
    metadata: { serviceCount: parsed.length },
  });
  return { yaml };
}

/**
 * ServiceModel -> the raw wire `ServiceSpec` (the `docker service create`
 * equivalent). The power-user escape hatch / preview. No DB, no dispatch.
 */
export function exportServiceSpec(model: unknown): { spec: ServiceSpecLike } {
  const parsed = ServiceModel.parse(model);
  return { spec: modelToServiceSpec(parsed) };
}

export interface DeployFromBuilderResult {
  id: string;
  deploymentId: string;
  warnings: TranslationWarning[];
}

/**
 * FULL-FIDELITY deploy from the GUI builder. Unlike `services.create` (the lossy
 * CreateServiceInput subset), this projects the ENTIRE canonical ServiceModel
 * through `modelToServiceSpec` so placement, mounts, labels, healthcheck,
 * resources, configs and secrets all reach the agent. Persists the denormalized
 * columns for list/display and dispatches the complete spec.
 */
export async function deployFromModel(
  ctx: OrgContext,
  input: { model: unknown; nodeId?: string },
): Promise<DeployFromBuilderResult> {
  const model: ServiceModelOut = ServiceModel.parse(input.model);
  const warnings = validateModel(model);
  if (warnings.some((w) => w.code === 'image-required' || w.code === 'name-required')) {
    throw new Error('Service name and image are required.');
  }

  const node = await resolveManagerNode(ctx, input.nodeId);
  const spec = modelToServiceSpec(model);

  // Docker is the source of truth: the deploy no longer writes a Service or
  // Deployment row. Callers still get a `deploymentId` for correlation, but it
  // is a synthetic, non-persisted id rather than a DB primary key.
  const deploymentId = randomUUID();

  try {
    await ctx.hub.dispatch(node.id, 'service.deploy', { spec, pullPolicy: 'always' });
  } catch (e) {
    throw mapDispatchError(e);
  }

  // Resolve the Docker service id from live inventory (falls back to the name
  // until the hub snapshot catches up with the just-dispatched deploy).
  const id = liveService(ctx, model.name)?.id ?? model.name;

  await writeAudit(ctx, {
    action: 'service.builder.deploy',
    targetType: 'service',
    targetId: id,
    metadata: { name: model.name, image: model.image, warningCount: warnings.length },
  });

  return { id, deploymentId, warnings };
}
