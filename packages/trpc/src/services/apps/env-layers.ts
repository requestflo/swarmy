/**
 * Shared vs override, read-only (Variables tab "Shared variables"): the
 * layers swarmy.yaml defines for every environment of a git app — service
 * env › environments.<name>.env › shared env — each value with its origin
 * and secret-looking values masked (`envLayers` masks; nothing here can
 * return a raw secret). The file is the one the stack last planned (the same
 * text the Source tab shows); dashboard environments appear as columns with
 * no layer of their own. Null = the stack isn't a git app.
 */
import { envLayers, parseAppConfig, type EnvLayers } from '@swarmy/app-config';
import type { OrgContext } from '../../context';
import { readAppConfigFile, type AppConfigFileView } from './config-file';
import { dashboardEnvironments } from './dashboard-envs';

export interface EnvLayersView {
  repoId: string;
  /** The environment whose last planned commit this file is from. */
  environment: string;
  path: string;
  sha: string;
  /** Null when that commit has no valid file; `reason` says why. */
  layers: EnvLayers | null;
  reason: string | null;
  /** Columns the dashboard declared (they live there until swarmy.yaml names them). */
  dashboard: string[];
}

type ReadFile = (ctx: OrgContext, input: { stack: string }) => Promise<AppConfigFileView | null>;

export async function readEnvLayers(
  ctx: OrgContext,
  input: { stack: string },
  read: ReadFile = readAppConfigFile,
): Promise<EnvLayersView | null> {
  const file = await read(ctx, input);
  if (!file) return null;
  const base = { repoId: file.repoId, environment: file.environment, path: file.path, sha: file.sha };
  const dashboard = (await dashboardEnvironments(ctx.db, file.repoId)).map((e) => e.environment).sort();
  if (file.text == null) return { ...base, layers: null, reason: `${file.path} isn't in that commit`, dashboard };
  const parsed = parseAppConfig(file.text);
  if (!parsed.config) {
    const first = parsed.issues.find((i) => i.severity === 'error');
    return { ...base, layers: null, reason: `${file.path} doesn't parse${first ? `: ${first.message}` : ''}`, dashboard };
  }
  return { ...base, layers: envLayers(parsed.config, dashboard), reason: null, dashboard };
}
