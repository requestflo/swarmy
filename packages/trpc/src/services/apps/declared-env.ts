/**
 * Paste .env (board 58): the variables swarmy.yaml declares for each service
 * in each environment of a git app, with the path that sets each one. The
 * dashboard shows those rows locked and never writes them. Names and paths
 * only — no value leaves here. The file is the one the stack last planned
 * (the same text the Source tab and Shared variables read), and every
 * environment is resolved from it: production, the file's own, and the
 * dashboard's clones (as the environment each was cloned from). Null = the
 * stack isn't a git app.
 */
import { declaredEnvByService, environmentStack, parseAppConfig, PRODUCTION, type DeclaredEnv } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { readAppConfigFile, type AppConfigFileView } from './config-file';
import { dashboardEnvironments } from './dashboard-envs';

export interface DeclaredEnvView {
  path: string;
  sha: string;
  /** Null when that commit has no valid file; `reason` says why (then nothing is locked). */
  reason: string | null;
  environments: Array<{
    environment: string;
    stack: string;
    /** service (short name) → key → the swarmy.yaml path that sets it. */
    services: Record<string, DeclaredEnv>;
  }>;
}

type ReadFile = (ctx: OrgContext, input: { stack: string }) => Promise<AppConfigFileView | null>;

export async function readDeclaredEnv(
  ctx: OrgContext,
  input: { stack: string },
  read: ReadFile = readAppConfigFile,
): Promise<DeclaredEnvView | null> {
  const file = await read(ctx, input);
  if (!file) return null;
  const base = { path: file.path, sha: file.sha };
  if (file.text == null) return { ...base, reason: `${file.path} isn't in that commit`, environments: [] };
  const parsed = parseAppConfig(file.text);
  const cfg = parsed.config;
  if (!cfg) {
    const first = parsed.issues.find((i) => i.severity === 'error');
    return { ...base, reason: `${file.path} doesn't parse${first ? `: ${first.message}` : ''}`, environments: [] };
  }
  const named = [PRODUCTION, ...Object.keys(cfg.environments ?? {})].map((environment) => ({
    environment,
    stack: environmentStack(cfg.app, environment),
    services: declaredEnvByService(cfg, environment),
  }));
  const clones = (await dashboardEnvironments(ctx.db, file.repoId))
    .filter((e) => !named.some((n) => n.environment === e.environment))
    .map((e) => ({ environment: e.environment, stack: e.stack, services: declaredEnvByService(cfg, e.environment, e.marker.from) }));
  return { ...base, reason: null, environments: [...named, ...clones] };
}
