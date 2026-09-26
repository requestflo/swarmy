import type { ServiceSpec } from '@swarmy/core/protocol';
import { secretMountPath, secretRefsFor } from '../secretsMgr.service';
import { substituteTokens, type WireAction } from './catalog';

/**
 * Wires that must be in the spec the service is FIRST created with (QA-073).
 * A database image reads its generated password once, on first boot: MySQL
 * without `MYSQL_PASSWORD` initialises the data dir and never creates the app
 * user, Postgres/Mongo likewise. Attaching the secret after the create is
 * therefore too late, so generated secrets (mounted or env-delivered) and
 * token-carrying env (credentials resolved at plan time) go on the create
 * spec. The compose source stays credential-free: this is applied to the
 * spec only, never persisted.
 */
export type CreateTimeWire = Extract<WireAction, { type: 'secret' } | { type: 'env' }>;

export function isCreateTimeWire(w: WireAction): w is CreateTimeWire {
  return w.type === 'secret' || w.type === 'env';
}

/**
 * PURE — fold a service's create-time wires into its spec. `secretNames` maps a
 * family to its physical Docker secret (created by an earlier plan step). The
 * shapes match `attachSecretToService` exactly, so a later attach / rotate
 * sees the same refs it would have made itself.
 */
export function withCreateTimeWires(
  spec: ServiceSpec,
  wires: readonly CreateTimeWire[],
  secretNames: Readonly<Record<string, string>>,
  tokens: Readonly<Record<string, string>>,
): ServiceSpec {
  if (!wires.length) return spec;
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  const secrets = [...(spec.secrets ?? [])];
  const secretEnv = new Set(spec.secretEnv ?? []);
  for (const w of wires) {
    if (w.type === 'env') {
      for (const [k, v] of Object.entries(w.env)) env[k] = substituteTokens(v, tokens);
      continue;
    }
    const name = secretNames[w.family];
    if (!name) throw new Error(`secret "${w.family}" was not created by this plan`);
    if (w.delivery === 'env') {
      // Exported as $envName by the secret-env shim; the spec holds only the NAME.
      if (!secrets.some((r) => r.source === name && r.target === w.envName)) secrets.push({ source: name, target: w.envName });
      secretEnv.add(w.envName);
      delete env[w.envName];
    } else {
      for (const ref of secretRefsFor([name])) {
        if (!secrets.some((r) => r.source === ref.source && r.target === ref.target)) secrets.push(ref);
      }
      if (w.envName) env[w.envName] = secretMountPath(w.family);
    }
  }
  const next: ServiceSpec = { ...spec, env };
  if (secrets.length) next.secrets = secrets;
  if (secretEnv.size) next.secretEnv = [...secretEnv].sort();
  return next;
}
