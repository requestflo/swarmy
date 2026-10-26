/**
 * Which of a service's variables swarmy.yaml declares in one environment, and
 * where (board 58, Paste .env: those rows are locked — "declared in
 * swarmy.yaml; change it there" — and a paste never overwrites them). The
 * precedence is `resolveEnvironment` + `toDesired`, lowest first:
 *
 *   env.<KEY>                                   shared, every service
 *   environments.<env>.env.<KEY>                this environment
 *   services.<svc>.env.<KEY>                    this service, every environment
 *   environments.<env>.services.<svc>.env.<KEY> this service here
 *
 * The answer is the path of the layer that wins. An environment the file
 * doesn't name (a dashboard clone) reads as the one it was cloned from
 * (`from`); production has no layer of its own. PURE.
 */
import { PRODUCTION } from './environments';
import type { AppConfig } from './schema';

export type DeclaredEnv = Record<string, string>;

/** key → the swarmy.yaml path that sets it for `service` in `environment`. */
export function declaredEnv(cfg: AppConfig, environment: string, service: string, from?: string): DeclaredEnv {
  const name = environment === PRODUCTION || cfg.environments?.[environment] ? environment : (from ?? PRODUCTION);
  const e = name === PRODUCTION ? undefined : cfg.environments?.[name];
  const out: DeclaredEnv = {};
  const layer = (env: Record<string, unknown> | undefined, path: string): void => {
    for (const k of Object.keys(env ?? {})) out[k] = `${path}.${k}`;
  };
  layer(cfg.env, 'env');
  layer(e?.env, `environments.${name}.env`);
  layer(cfg.services[service]?.env, `services.${service}.env`);
  layer(e?.services?.[service]?.env, `environments.${name}.services.${service}.env`);
  return out;
}

/** Every service's declared variables in one environment. */
export function declaredEnvByService(cfg: AppConfig, environment: string, from?: string): Record<string, DeclaredEnv> {
  return Object.fromEntries(Object.keys(cfg.services).map((s) => [s, declaredEnv(cfg, environment, s, from)]));
}
