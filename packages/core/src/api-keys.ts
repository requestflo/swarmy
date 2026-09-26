/**
 * API key scopes, the three presets the dashboard offers, and key expiry —
 * the one place the preset → scope map lives (owner decision Q7).
 *
 * Scopes are what `requireScope` checks on every `/api/v1` route:
 *
 *   - `read`          every GET
 *   - `deploy`        ship and roll back: deploy a stack/service, change its env,
 *                     scale, restart, promote, preview (implies `read`)
 *   - `write`         every mutation, including the org-wide ones — servers,
 *                     keys, DNS, backups, registry, git (implies `deploy`, `read`)
 *   - `secrets.read`  reveal secret values (service env) — never implied
 *
 * A key still acts as its creator's CURRENT role, and the org's policies still
 * apply: a scope is the key's ceiling, never a grant of its own.
 *
 * Browser-safe (no node imports): the dashboard renders the presets from here.
 */

export const API_KEY_SCOPES = ['read', 'deploy', 'write', 'secrets.read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type ApiKeyPreset = 'read' | 'deploy' | 'admin';

export interface ApiKeyPresetInfo {
  label: string;
  /** The board's short line under the label. */
  blurb: string;
  /** Plain words for "This key can …". */
  can: string;
  scopes: ApiKeyScope[];
}

/**
 * Read-only sees everything and changes nothing. Deploy ships and rolls back
 * apps. Admin is everything a key can do: swarmy has no billing scope, so
 * "everything but billing" is every scope (including revealing secrets).
 */
export const API_KEY_PRESETS: Record<ApiKeyPreset, ApiKeyPresetInfo> = {
  read: { label: 'Read-only', blurb: 'see, never change', can: 'see', scopes: ['read'] },
  deploy: { label: 'Deploy', blurb: 'ship + roll back', can: 'see and ship', scopes: ['read', 'deploy'] },
  admin: {
    label: 'Admin',
    blurb: 'everything but billing',
    can: 'do anything, including reading secrets, on',
    scopes: ['read', 'write', 'secrets.read'],
  },
};

export const API_KEY_PRESET_ORDER: ApiKeyPreset[] = ['read', 'deploy', 'admin'];

/** Does a key holding `granted` satisfy a route that needs `needed`? */
export function scopeSatisfies(granted: readonly string[], needed: ApiKeyScope): boolean {
  if (granted.includes(needed)) return true;
  if (needed === 'read') return granted.includes('deploy') || granted.includes('write');
  if (needed === 'deploy') return granted.includes('write');
  return false;
}

/** The preset a stored scope set matches, or `custom` (older keys, CLI keys). */
export function presetOf(scopes: readonly string[]): ApiKeyPreset | 'custom' {
  const set = [...new Set(scopes)].sort().join(',');
  for (const p of API_KEY_PRESET_ORDER) {
    if ([...API_KEY_PRESETS[p].scopes].sort().join(',') === set) return p;
  }
  return 'custom';
}

export const API_KEY_EXPIRIES = ['30d', '90d', '1y', 'never'] as const;
export type ApiKeyExpiry = (typeof API_KEY_EXPIRIES)[number];

const EXPIRY_DAYS: Record<ApiKeyExpiry, number | null> = { '30d': 30, '90d': 90, '1y': 365, never: null };

export const API_KEY_EXPIRY_LABEL: Record<ApiKeyExpiry, string> = {
  '30d': '30 d',
  '90d': '90 d',
  '1y': '1 y',
  never: 'never',
};

/** When a key created `now` with `choice` stops working; null = never. */
export function apiKeyExpiresAt(choice: ApiKeyExpiry, now: Date = new Date()): Date | null {
  const days = EXPIRY_DAYS[choice];
  return days === null ? null : new Date(now.getTime() + days * 86_400_000);
}

/** Is this app (stack name) inside a key's app list? null = every app. */
export function keyReachesApp(stackNames: readonly string[] | null | undefined, stack: string | null | undefined): boolean {
  if (!stackNames) return true;
  return Boolean(stack) && stackNames.includes(stack as string);
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The plain sentence the New key panel shows: "This key can see and ship
 * storefront and api. It stops working in 90 days."
 */
export function describeApiKey(args: {
  preset: ApiKeyPreset;
  stackNames: readonly string[] | null;
  expiry: ApiKeyExpiry;
}): string {
  const where = args.stackNames && args.stackNames.length ? list(args.stackNames) : 'every app';
  const verb = API_KEY_PRESETS[args.preset].can;
  const scope =
    args.preset === 'read'
      ? `This key can see ${where}, but never change anything.`
      : args.preset === 'deploy'
        ? `This key can see and ship ${where}, and put back an earlier version.`
        : `This key can ${verb} ${where}${args.stackNames?.length ? '' : ', servers and settings'}.`;
  const days = EXPIRY_DAYS[args.expiry];
  const ends =
    days === null
      ? 'It never expires, so revoke it when you are done.'
      : `It stops working in ${days === 365 ? 'a year' : `${days} days`}.`;
  return `${scope} ${ends}`;
}
