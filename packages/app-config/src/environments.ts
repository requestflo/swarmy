/**
 * Named environments (staging, qa, …): the same swarmy.yaml, deployed as its
 * own stack `<app>-<name>` that tracks its own branch, with per-environment
 * overrides. Production is implicit — it is the file as written, deployed from
 * the repo binding's branch.
 *
 * Merge rules (pure; `resolveEnvironment` returns a plain AppConfig so the rest
 * of the pipeline — validate, toDesired, planApp — needs no special cases):
 *   - env: app env ← environment env ← service env ← environment service env.
 *   - A service's `domains` are DROPPED unless the environment gives its own:
 *     production hostnames never leak into another environment.
 *   - Resource overrides merge into the resource (the type never changes).
 *   - Jobs run unless `jobs: false`; `connect` is the environment's own list
 *     (production links don't carry over); previews stay a production concern.
 */
import type { AppConfig } from './schema';

export const PRODUCTION = 'production';

export function environmentStack(app: string, environment: string): string {
  return environment === PRODUCTION ? app : `${app}-${environment}`;
}

/** Which environment a push to `branch` deploys: production, a named one, or none. */
export function environmentForBranch(
  cfg: AppConfig,
  branch: string,
  productionBranch: string,
): string | null {
  if (branch === productionBranch) return PRODUCTION;
  for (const [name, e] of Object.entries(cfg.environments ?? {}))
    if (e.branch === branch) return name;
  return null;
}

/** Every branch the app deploys from, production first. */
export function environmentBranches(
  cfg: AppConfig,
  productionBranch: string,
): Array<{ environment: string; branch: string }> {
  return [
    { environment: PRODUCTION, branch: productionBranch },
    ...Object.entries(cfg.environments ?? {}).map(([environment, e]) => ({
      environment,
      branch: e.branch,
    })),
  ];
}

export function resolveEnvironment(cfg: AppConfig, environment: string): AppConfig {
  if (environment === PRODUCTION) return cfg;
  const e = cfg.environments?.[environment];
  if (!e) throw new Error(`no environment named "${environment}"`);

  const services: AppConfig['services'] = {};
  for (const [name, s] of Object.entries(cfg.services)) {
    const o = e.services?.[name] ?? {};
    const { domains: _prodDomains, ...rest } = s;
    const env = { ...(e.env ?? {}), ...(s.env ?? {}), ...(o.env ?? {}) };
    services[name] = {
      ...rest,
      ...(o.replicas !== undefined ? { replicas: o.replicas } : {}),
      ...(o.sleep_after !== undefined ? { sleep_after: o.sleep_after } : {}),
      ...(o.size !== undefined ? { size: o.size, cpu: undefined, memory: undefined } : {}),
      ...(o.cpu !== undefined ? { cpu: o.cpu } : {}),
      ...(o.memory !== undefined ? { memory: o.memory } : {}),
      ...(o.regions !== undefined ? { regions: o.regions } : {}),
      ...(o.command !== undefined ? { command: o.command } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(o.domains ? { domains: o.domains } : {}),
    } as AppConfig['services'][string];
  }

  let resources: AppConfig['resources'];
  if (cfg.resources) {
    resources = {};
    for (const [name, raw] of Object.entries(cfg.resources)) {
      const base = typeof raw === 'string' ? { type: raw } : raw;
      const o = e.resources?.[name];
      resources[name] = (o ? { ...base, ...o } : base) as NonNullable<
        AppConfig['resources']
      >[string];
    }
  }

  const { environments: _envs, previews: _previews, connect: _connect, jobs, ...top } = cfg;
  return {
    ...top,
    services,
    ...(resources ? { resources } : {}),
    ...(jobs && e.jobs !== false ? { jobs } : {}),
    ...(e.connect ? { connect: e.connect } : {}),
  };
}
