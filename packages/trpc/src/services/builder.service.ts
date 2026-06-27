import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  composeToModels,
  modelsToCompose,
  ServiceModel,
  type ServiceModelOut,
  type TranslationWarning,
} from '@swarmy/core/compose';
import { writeAudit } from '../services/audit.service';
import type { OrgContext } from '../context';

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
