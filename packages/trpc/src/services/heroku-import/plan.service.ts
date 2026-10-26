/**
 * Import from Heroku, step 2: the plan. The app is read (Platform API with
 * the caller's token, or the pasted files), converted to swarmy.yaml,
 * checked with the controller's parser, and said in plain words. Read-only:
 * nothing in swarmy or on Heroku changes. Config var VALUES never come back:
 * the browser gets names, and whether the controller holds a value it can
 * seal or copy from.
 */
import {
  herokuImportPlan,
  herokuMigrationSteps,
  parseAppConfig,
  type HerokuImportPlan,
  type HerokuMigration,
} from '@swarmy/app-config';
import type { HerokuImportPlanInput } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { writeAudit } from '../audit.service';
import { parsePgUrl } from './pg-copy';
import { resolveHeroku, type ResolvedHeroku } from './source';

export interface HerokuImportView {
  source: 'api' | 'paste';
  /** The app's name on Heroku. */
  herokuApp: string;
  /** The swarmy app (and stack) it becomes. */
  app: string;
  plan: HerokuImportPlan;
  yaml: string;
  /** The controller's parser found no errors. */
  valid: boolean;
  issues: Array<{ severity: 'error' | 'warning'; message: string; line?: number }>;
  /** What changed shape on the way. */
  changes: string[];
  /** The manual way across (pg:backups → restore, heroku config → Paste .env). */
  steps: HerokuMigration;
  /** Secrets Deploy can seal now: the controller holds their values. */
  sealable: string[];
  /** Databases the one-shot copy can read from: their Heroku URL is in the config. */
  copyable: string[];
}

/** Pure: a resolved app → the browser's view (no values). */
export function importView(r: ResolvedHeroku, source: 'api' | 'paste'): HerokuImportView {
  const yaml = r.conv.yaml!;
  const sealable = r.conv.secrets.filter((s) => r.config[s.key]).map((s) => s.name);
  const plan = herokuImportPlan(r.conv, sealable);
  const issues = parseAppConfig(yaml).issues.map((i) => ({ severity: i.severity, message: i.message, ...(i.line ? { line: i.line } : {}) }));
  return {
    source,
    herokuApp: r.herokuApp,
    app: r.conv.app,
    plan: plan ?? { app: r.conv.app, headline: 'The swarmy.yaml needs a fix before it deploys.', services: [], data: [], plainVars: [], secrets: [], bound: [], domains: [], jobs: [], todo: r.conv.untranslated, handled: [] },
    yaml,
    valid: Boolean(plan) && !issues.some((i) => i.severity === 'error'),
    issues,
    changes: r.conv.changes,
    steps: herokuMigrationSteps(r.conv, { herokuApp: r.herokuApp }),
    sealable,
    copyable: r.conv.databases.filter((d) => parsePgUrl(r.config[d.envVar] ?? '')).map((d) => d.resource),
  };
}

export async function planHerokuImport(ctx: OrgContext, input: HerokuImportPlanInput, resolve = resolveHeroku): Promise<HerokuImportView> {
  const r = await resolve(input.source, input.name);
  await writeAudit(ctx, {
    action: 'heroku.import.plan',
    targetType: 'stack',
    targetId: r.conv.app,
    metadata: { source: input.source.kind, herokuApp: r.herokuApp },
  });
  return importView(r, input.source.kind);
}
