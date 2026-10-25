/**
 * Import from Heroku, step 3: Deploy what swarmy can run before the code
 * arrives. The app's code lives in git and swarmy builds it on a push, so
 * Deploy sets up everything else the swarmy.yaml names:
 *
 *  - each managed Postgres and cache, through the SAME `createResource` the
 *    git applier runs, so the first push adopts them as they are;
 *  - each sealed config var as a swarmy secret with Heroku's value (the
 *    family the file reads as `${{ secrets.<name> }}`); the value goes
 *    straight to Docker and is never stored or returned.
 *
 * Idempotent: what already exists is kept and said so. The app's services
 * deploy on the first push of the swarmy.yaml; the data copy is its own step.
 */
import { parseAppConfig, toDesired, type DesiredApp, type DesiredResource } from '@swarmy/app-config';
import { buildInventory, type HerokuImportDeployInput } from '@swarmy/core';
import type { OrgContext } from '../../context';
import { realOps } from '../apps.service';
import { resourceServiceName } from '../apps/live';
import { writeAudit } from '../audit.service';
import { createSecretFamily } from '../secretsMgr.service';
import { resolveHeroku, type ResolvedHeroku } from './source';

export interface HerokuDeployStep {
  key: string;
  say: string;
  status: 'created' | 'already' | 'skipped' | 'failed';
}

export interface HerokuDeployResult {
  stack: string;
  steps: HerokuDeployStep[];
  /** The swarmy.yaml to commit: the push that carries it deploys the services. */
  yaml: string;
}

export interface DeployDeps {
  resolve: (src: HerokuImportDeployInput['source'], name: string) => Promise<ResolvedHeroku>;
  liveServiceNames: (ctx: OrgContext) => Set<string>;
  createResource: (ctx: OrgContext, r: DesiredResource, d: DesiredApp) => Promise<unknown>;
  createSecret: (ctx: OrgContext, family: string, value: string, stack: string) => Promise<unknown>;
}

const DEFAULT_DEPS: DeployDeps = {
  resolve: (src, name) => resolveHeroku(src, name),
  liveServiceNames: (ctx) => {
    const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
    return new Set(buildInventory(services, containers).services.map((s) => s.name));
  },
  createResource: (ctx, r, d) => realOps(ctx, d, { id: '', branch: '' }, '').createResource(r, d),
  createSecret: (ctx, family, value, stack) => createSecretFamily(ctx, { family, value, stack }),
};

const what = (r: DesiredResource): string => (r.type === 'postgres' ? `Postgres ${r.version} database “${r.name}”` : `cache “${r.name}”`);
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function deployHerokuImport(ctx: OrgContext, input: HerokuImportDeployInput, deps: DeployDeps = DEFAULT_DEPS): Promise<HerokuDeployResult> {
  const r = await deps.resolve(input.source, input.stack);
  const cfg = parseAppConfig(r.conv.yaml!).config;
  if (!cfg) throw new Error('The imported swarmy.yaml has errors: fix them on the plan first.');
  const desired = toDesired(cfg);
  const live = deps.liveServiceNames(ctx);
  const steps: HerokuDeployStep[] = [];

  for (const res of desired.resources.filter((x) => x.type === 'postgres' || x.type === 'cache')) {
    const key = `resources.${res.name}`;
    const svc = resourceServiceName(desired.stack, res);
    if (svc && live.has(svc)) {
      steps.push({ key, status: 'already', say: `The ${what(res)} is already running; swarmy keeps it.` });
      continue;
    }
    try {
      await deps.createResource(ctx, res, desired);
      steps.push({ key, status: 'created', say: `Started the ${what(res)}.` });
    } catch (e) {
      steps.push({ key, status: 'failed', say: `Couldn’t start the ${what(res)}: ${reason(e)}` });
    }
  }

  for (const s of r.conv.secrets) {
    const key = `secrets.${s.name}`;
    const value = r.config[s.key];
    if (!value) {
      steps.push({ key, status: 'skipped', say: `${s.key} has no value from Heroku: add the secret ${s.name} on Variables & secrets.` });
      continue;
    }
    try {
      await deps.createSecret(ctx, s.name, value, desired.stack);
      steps.push({ key, status: 'created', say: `Sealed ${s.key} as the secret ${s.name}.` });
    } catch (e) {
      const exists = /already exists/.test(reason(e));
      const kept = `A secret named ${s.name} already exists, so swarmy left it as it is. If another app owns it, give ${s.key} its own secret name in swarmy.yaml.`;
      steps.push({ key, status: exists ? 'already' : 'failed', say: exists ? kept : `Couldn’t seal ${s.key}: ${reason(e)}` });
    }
  }

  await writeAudit(ctx, {
    action: 'heroku.import.deploy',
    targetType: 'stack',
    targetId: desired.stack,
    metadata: { source: input.source.kind, herokuApp: r.herokuApp, steps: steps.map((s) => `${s.key}:${s.status}`) },
  });
  return { stack: desired.stack, steps, yaml: r.conv.yaml! };
}
