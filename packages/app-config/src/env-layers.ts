/**
 * Shared vs override (boards Environments · AppVariables "Shared variables"):
 * every app-wide variable swarmy.yaml declares, per environment, with the
 * layer its value comes from. The precedence is exactly `resolveEnvironment`
 * + `toDesired`:
 *
 *   service env (and environments.<name>.services.<svc>.env over it)
 *     › environments.<name>.env › shared env (top-level `env:`)
 *
 * Rows are the keys of the shared layer, of any environment's env, and of any
 * environment's per-service override — a service's own key that no
 * environment touches is a service variable, not a shared one. PURE: the
 * values are masked here (`looksSecret`, the env editor's heuristic) so no
 * caller can forget; a value that is only a binding (`${{ db.url }}`) is a
 * reference, never a secret, and stays readable.
 */
import { looksSecret } from '@swarmy/core';
import { BINDING_RE } from './bindings';
import { PRODUCTION } from './environments';
import type { AppConfig } from './schema';

export const MASKED_VALUE = '••••••';

export type EnvCellOrigin = 'shared' | 'environment';

export interface EnvServiceValue {
  service: string;
  value: string;
  /** `service` = services.<svc>.env (every environment); `environment` = this environment's override of it. */
  layer: 'service' | 'environment';
}

export interface EnvLayerCell {
  /** What a service without its own value gets here; null = not set app-wide in this environment. */
  value: string | null;
  origin: EnvCellOrigin | null;
  /** Services that set their own value for this key here (they win over `value`). */
  services: EnvServiceValue[];
}

export interface EnvLayerRow {
  key: string;
  /** The shared (top-level `env:`) value, or null. */
  shared: string | null;
  /** At least one value was masked. */
  secret: boolean;
  /** environment → cell, for every name in `EnvLayers.environments`. */
  envs: Record<string, EnvLayerCell>;
}

export interface EnvLayers {
  /** production first, then the file's environments, then `extra` (dashboard environments). */
  environments: string[];
  rows: EnvLayerRow[];
}

type EnvValues = Record<string, string | number | boolean> | undefined;

const onlyBindings = (v: string): boolean => v.replace(BINDING_RE, '').trim() === '' && v.includes('${{');

/** Mask a value the way every read of app env does; bindings stay readable. */
export function maskEnvValue(key: string, value: string): { value: string; masked: boolean } {
  if (onlyBindings(value) || !looksSecret(key, value)) return { value, masked: false };
  return { value: MASKED_VALUE, masked: true };
}

/** An environment's shared-vs-override cell: the whole precedence in one place. */
export function isOverride(cell: EnvLayerCell | undefined): boolean {
  return !!cell && (cell.origin === 'environment' || cell.services.some((s) => s.layer === 'environment'));
}

export function envLayers(cfg: AppConfig, extra: readonly string[] = []): EnvLayers {
  const named = Object.keys(cfg.environments ?? {});
  const environments = [PRODUCTION, ...named, ...extra.filter((e) => e !== PRODUCTION && !named.includes(e))];
  const keys = new Set(Object.keys(cfg.env ?? {}));
  for (const e of Object.values(cfg.environments ?? {})) {
    for (const k of Object.keys(e.env ?? {})) keys.add(k);
    for (const o of Object.values(e.services ?? {})) for (const k of Object.keys(o.env ?? {})) keys.add(k);
  }

  const rows: EnvLayerRow[] = [];
  for (const key of [...keys].sort()) {
    let secret = false;
    const show = (v: string | number | boolean | undefined): string | null => {
      if (v === undefined) return null;
      const m = maskEnvValue(key, String(v));
      secret ||= m.masked;
      return m.value;
    };
    const has = (env: EnvValues): boolean => !!env && Object.prototype.hasOwnProperty.call(env, key);
    const shared = show(cfg.env?.[key]);
    const envs: Record<string, EnvLayerCell> = {};
    for (const name of environments) {
      const e = name === PRODUCTION ? undefined : cfg.environments?.[name];
      const fromEnv = has(e?.env);
      const cell: EnvLayerCell = {
        value: fromEnv ? show(e!.env![key]) : shared,
        origin: fromEnv ? 'environment' : shared !== null ? 'shared' : null,
        services: [],
      };
      for (const [svc, s] of Object.entries(cfg.services)) {
        const o = e?.services?.[svc]?.env;
        if (has(o)) cell.services.push({ service: svc, value: show(o![key])!, layer: 'environment' });
        else if (has(s.env)) cell.services.push({ service: svc, value: show(s.env![key])!, layer: 'service' });
      }
      envs[name] = cell;
    }
    rows.push({ key, shared, secret, envs });
  }
  return { environments, rows };
}
