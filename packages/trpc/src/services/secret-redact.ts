import { looksSecret } from '@swarmy/core';
import type { ResourceInput } from '@swarmy/abac';
import type { OrgContext } from '../context';
import { evaluateAccess } from '../abac';

/**
 * Secret env values are shown only to callers with `secrets.read` (owners and
 * admins by default; anyone else by an explicit grant). Everyone else gets the
 * same payload with secret-looking values masked — the key names stay, so the
 * shape of an app is still inspectable. `looksSecret` (key name, then value
 * shape) is the one heuristic shared with the env editor.
 */

export const REDACTED = '••••••';

/** `KEY=value` → `KEY=••••••` when the pair looks secret. */
export function redactEnvEntry(entry: string): string {
  const eq = entry.indexOf('=');
  if (eq <= 0) return entry;
  const key = entry.slice(0, eq);
  const value = entry.slice(eq + 1);
  return looksSecret(key, value) ? `${key}=${REDACTED}` : entry;
}

/**
 * Deep-copy a `docker service inspect` payload, masking every `Env` list
 * (ContainerSpec.Env, and any nested one) entry that looks secret.
 */
export function redactInspect<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactInspect(v)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'Env' && Array.isArray(v)) {
      out[k] = v.map((e) => (typeof e === 'string' ? redactEnvEntry(e) : e));
    } else {
      out[k] = redactInspect(v);
    }
  }
  return out as T;
}

const KV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][\w.-]*)(\s*[=:]\s*)(.*)$/;

/**
 * Mask secret-looking values in config file text: dotenv (`KEY=value`,
 * `export KEY=value`) and YAML/INI-style `key: value` lines. Anything else
 * (JSON blobs, certificates) is judged on the value shape alone, line by line.
 */
export function redactConfigText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let inKey = false;
  const lines = text.split('\n').map((line) => {
    // A PEM private key: mask the whole block, not just its header.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = true;
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = false;
      redacted = true;
      return REDACTED;
    }
    const m = KV_LINE.exec(line);
    if (m) {
      const [, lead, key, sep, raw] = m as unknown as [string, string, string, string, string];
      const value = raw.trim().replace(/^["']|["'],?$/g, '');
      if (value && looksSecret(key, value)) {
        redacted = true;
        return `${lead}${key}${sep}${REDACTED}`;
      }
      return line;
    }
    if (looksSecret('', line.trim())) {
      redacted = true;
      return REDACTED;
    }
    return line;
  });
  return { text: lines.join('\n'), redacted };
}

/**
 * May the caller see secret values on this resource? The same decision path
 * as `authorize` (no audit row: this is a view filter, not a gated action).
 */
export async function canReadSecrets(ctx: OrgContext, resource: ResourceInput | null): Promise<boolean> {
  const r = await evaluateAccess(ctx, 'secrets.read', resource);
  return r.decision === 'permit';
}
