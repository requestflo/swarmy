import type { ServiceSpec } from '@swarmy/core/protocol';
import { parsePhysicalSecretName } from './secretsMgr.service';

/**
 * Secret FAMILIES (`<family>__v<n>`: blueprint-generated passwords, secrets
 * attached from the Secrets page) live only on the Docker service — the
 * stored compose never names them. A plain redeploy rebuilds each spec from
 * that compose, so without this it would drop a database's password mount
 * and break the app (QA-073 follow-up). Docker is the truth: the refs are
 * read from the live spec (`service inspect`, targets included).
 */

const SECRETS_DIR = '/run/secrets/';

/** Does the live service mount any managed secret-family version? (inventory NAMES) */
export function mountsSecretFamily(liveSecretNames: readonly string[] | undefined): boolean {
  return (liveSecretNames ?? []).some((n) => parsePhysicalSecretName(n) !== null);
}

/**
 * PURE — carry the live spec's family refs onto a compose-built spec: each
 * `<family>__v<n>` ref (exact source + target), its env-delivered name
 * (`secretEnv`) and any env var pointing at its mount path (`*_FILE`). The
 * compose wins on conflict: a target it already mounts, or an env key it
 * sets itself, is left alone.
 */
export function carrySecretFamilies(spec: ServiceSpec, live: ServiceSpec | undefined): ServiceSpec {
  const liveRefs = (live?.secrets ?? []).filter((r) => parsePhysicalSecretName(r.source) !== null);
  if (!liveRefs.length) return spec;
  const secrets = [...(spec.secrets ?? [])];
  const takenTargets = new Set(secrets.map((r) => r.target ?? r.source));
  const env: Record<string, string> = { ...(spec.env ?? {}) };
  const secretEnv = new Set(spec.secretEnv ?? []);
  const liveSecretEnv = new Set(live?.secretEnv ?? []);
  const carried = new Set<string>();
  for (const r of liveRefs) {
    const target = r.target ?? r.source;
    if (takenTargets.has(target)) continue;
    takenTargets.add(target);
    secrets.push(r);
    carried.add(target);
    if (liveSecretEnv.has(target) && env[target] === undefined) secretEnv.add(target);
  }
  if (!carried.size) return spec;
  for (const [k, v] of Object.entries(live?.env ?? {})) {
    if (env[k] !== undefined || !v.startsWith(SECRETS_DIR)) continue;
    if (carried.has(v.slice(SECRETS_DIR.length))) env[k] = v;
  }
  const out: ServiceSpec = { ...spec, secrets };
  if (Object.keys(env).length) out.env = env;
  if (secretEnv.size) out.secretEnv = [...secretEnv].sort();
  return out;
}
