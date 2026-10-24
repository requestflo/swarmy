/**
 * A compose service's `environment:` as swarmy.yaml `env:` — pure.
 *
 *  - A connection string to a service that became a managed resource turns
 *    into a binding (`postgres://…@db…` → `${{ db.url }}`).
 *  - A literal credential becomes a swarmy secret binding: the file is headed
 *    for git, so its value stays out of it (the gap says which secret to make).
 *  - A compose `${VAR}` read is flagged: swarmy.yaml leaves it verbatim.
 */
import type { ComposeGap } from './from-compose-gaps';

export type ResourceKind = 'postgres' | 'cache' | 'search' | 'vector' | 'bucket';
export type ResourceHosts = Map<string, { name: string; kind: ResourceKind }>;

/** Env-var URL schemes that point at a resource of this kind. */
const URL_SCHEMES: Record<ResourceKind, RegExp> = {
  postgres: /^postgres(ql)?:\/\//i,
  cache: /^rediss?:\/\//i,
  search: /^https?:\/\//i,
  vector: /^https?:\/\//i,
  bucket: /^https?:\/\//i,
};

const CREDENTIAL_KEY = /(^|_)(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY)(_|$)/i;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:[^/@\s]+@/i;
const PLAIN = /^(true|false|yes|no|on|off|\d+)$/i;

/** A literal value that looks like a credential: a password-ish key, or a URL with a password in it. */
export function looksLikeCredential(key: string, value: string): boolean {
  if (value.includes('${')) return false;
  if (URL_WITH_PASSWORD.test(value)) return true;
  return CREDENTIAL_KEY.test(key) && value.length >= 6 && !PLAIN.test(value);
}

/** `API_TOKEN` → `api-token`, a swarmy secret name. */
export function secretNameFor(key: string): string {
  const n = key.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return /^[a-z]/.test(n) ? n : `s-${n}`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bindingFor(value: string, hosts: ResourceHosts): string | null {
  for (const [host, r] of hosts) {
    const re = new RegExp(`(^|[@/])${escapeRe(host)}(:|/|$)`);
    if (re.test(value) && URL_SCHEMES[r.kind].test(value)) return `\${{ ${r.name}.url }}`;
    if (value === host) return `\${{ ${r.name}.host }}`;
  }
  return null;
}

export interface EnvConversion {
  env: Record<string, string>;
  changes: string[];
  gaps: ComposeGap[];
}

export function envFor(service: string, env: Record<string, string>, hosts: ResourceHosts): EnvConversion {
  const out: EnvConversion = { env: {}, changes: [], gaps: [] };
  for (const [k, v] of Object.entries(env)) {
    const key = `environment.${k}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      out.gaps.push({ service, key, reason: "that isn't a variable name swarmy.yaml accepts" });
      continue;
    }
    const bound = bindingFor(v, hosts);
    if (bound) {
      out.changes.push(`${service}: ${k} now binds to ${bound} (swarmy fills in the real address and password).`);
      out.env[k] = bound;
      continue;
    }
    if (looksLikeCredential(k, v)) {
      const name = secretNameFor(k);
      out.gaps.push({ service, key, reason: `its value looks like a credential, so it stays out of a file headed for git: create the swarmy secret ${name} with it (the file reads \${{ secrets.${name} }})` });
      out.env[k] = `\${{ secrets.${name} }}`;
      continue;
    }
    const compose = /\$\{[^}]+\}/.exec(v);
    if (compose) out.gaps.push({ service, key, reason: `it reads the compose variable ${compose[0]}, which swarmy.yaml leaves as written: put the value here, or in a swarmy secret` });
    out.env[k] = v.replace(/\$\{\{/g, '$$${{');
  }
  return out;
}
