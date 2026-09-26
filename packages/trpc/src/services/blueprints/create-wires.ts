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
  const fallback = new Set(spec.secretEnvFileFallback ?? []);
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
      if (w.fileFallback) fallback.add(w.envName);
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
  if (fallback.size) next.secretEnvFileFallback = [...fallback].sort();
  return next;
}

// ── Credential env → secret (no plaintext credential in any spec) ────────────

const FAMILY_MAX = 56; // Docker's 64-char cap minus `__v<n>` (secretsMgr)

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A secret family for one credential env var of one blueprint service. */
export function credentialEnvFamily(stack: string, service: string, key: string): string {
  const full = `${stack}_${service}_${key}`.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  const safe = full.replace(/__v\d+$/, (m) => m.replace('__', '_'));
  return safe.length <= FAMILY_MAX ? safe : `${safe.slice(0, FAMILY_MAX - 9)}-${shortHash(full)}`;
}

/**
 * PURE — turn every `env` wire entry whose value carries a CREDENTIAL token
 * (a DB/cache password or URL, a generated secret) into a secret wire
 * delivered as env by the secret-env shim. The spec then names a Docker
 * secret, never the value (`docker service inspect` shows no password).
 * Returns the rewritten wires + the secret families to create, with the raw
 * (token-bearing) template each one holds.
 */
export function credentialEnvToSecrets(
  wires: readonly WireAction[],
  stack: string,
  credentialTokens: ReadonlySet<string>,
): { wires: WireAction[]; families: Array<{ family: string; template: string }> } {
  const out: WireAction[] = [];
  const families: Array<{ family: string; template: string }> = [];
  const carries = (v: string) => [...credentialTokens].some((t) => v.includes(t));
  for (const w of wires) {
    if (w.type !== 'env') {
      out.push(w);
      continue;
    }
    const plain: Record<string, string> = {};
    for (const [key, value] of Object.entries(w.env)) {
      if (!carries(value)) {
        plain[key] = value;
        continue;
      }
      const family = credentialEnvFamily(stack, w.service, key);
      families.push({ family, template: value });
      out.push({ type: 'secret', service: w.service, family, envName: key, delivery: 'env', fileFallback: true });
    }
    if (Object.keys(plain).length) out.push({ ...w, env: plain });
  }
  return { wires: out, families };
}
