/**
 * Per-path "who can enter" for a login-protected app (board 65): a protected
 * route may carry `access.paths` on its `swarmy.ingress.routes` entry,
 *
 *   { "login": true, "paths": [{ "path": "/admin/*", "groups": ["admins"] }] }
 *
 * judged on the forwarded request path, most-specific prefix first. Rules
 * only NARROW: a request must already pass the app's who-can-enter (ABAC
 * `app.access`), then the closest rule must admit the person. No rule under
 * the path = the app's who-can-enter alone. Pure, shared by the controller
 * (forward-auth) and the dashboard (the simulator).
 *
 * The path is read the way the edge reads it (Caddy's path matcher: decode
 * percent-escapes once, merge slashes, resolve dot segments, compare
 * case-insensitively). Because the app behind the edge may read the raw path
 * differently, the closest rule must admit the person under every reading:
 * dot segments resolved or kept, `;params` and backslashes kept or folded.
 * A path that cannot be read (bad or double escapes, control characters)
 * and a rule set that cannot be parsed both fail closed.
 */

export type AppPathRole = 'owner' | 'admin' | 'member';

export interface AppPathRule {
  /** `/admin` or `/admin/*`: this path and everything under it, on segment boundaries. */
  path: string;
  /** Anyone the app's who-can-enter admits. */
  everyone?: boolean;
  roles?: AppPathRole[];
  groups?: string[];
  /** Member ids. */
  people?: string[];
}

export interface AppPathPrincipal {
  memberId?: string | null;
  role: string;
  groups: readonly string[];
}

export const APP_PATH_RULES_MAX = 50;
const KEYS = new Set(['path', 'everyone', 'roles', 'groups', 'people']);
const ROLES: readonly string[] = ['owner', 'admin', 'member'];

/** A rule's path as matched: lowercase, no trailing `/*`, `*` or `/`. Null = not a usable prefix. */
export function ruleKey(path: string): string | null {
  if (path.length === 0 || path.length > 512 || !path.startsWith('/')) return null;
  const bare = path.replace(/\/?\*$/, '').replace(/\/+$/, '') || '/';
  if (/[*?#%;\\\s]|\/\/|(^|\/)\.\.?(\/|$)/.test(bare) || /[\x00-\x1f\x7f]/.test(bare)) return null;
  return bare.toLowerCase();
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200);

/**
 * The label's `access.paths`, validated. `undefined` = no rules (`[]`). Null =
 * unparseable — not an array, too many, an unknown key, a wrong type, a bad
 * path or the same path twice — and the caller refuses every request.
 */
export function parseAppPathRules(raw: unknown): AppPathRule[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > APP_PATH_RULES_MAX) return null;
  const out: AppPathRule[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
    const v = r as Record<string, unknown>;
    if (Object.keys(v).some((k) => !KEYS.has(k)) || typeof v.path !== 'string') return null;
    const key = ruleKey(v.path);
    if (key === null || seen.has(key)) return null;
    seen.add(key);
    if (v.everyone !== undefined && typeof v.everyone !== 'boolean') return null;
    for (const k of ['roles', 'groups', 'people'] as const) if (v[k] !== undefined && !strings(v[k])) return null;
    if (v.roles !== undefined && !(v.roles as string[]).every((x) => ROLES.includes(x))) return null;
    out.push(v as unknown as AppPathRule);
  }
  return out;
}

/** Decode percent-escapes once, as Go's URL parser does for the edge. Null = refuse. */
function decodeOnce(path: string): string | null {
  if (/%(?![0-9a-f]{2})/i.test(path)) return null;
  let d: string;
  try {
    d = decodeURIComponent(path);
  } catch {
    return null; // invalid UTF-8 (overlong encodings included)
  }
  // A second layer of escapes, or control characters: read differently by different apps.
  if (/%[0-9a-f]{2}/i.test(d) || /[\x00-\x1f\x7f]/.test(d)) return null;
  return d;
}

function segments(path: string, resolveDots: boolean, fold: boolean): string {
  const raw = (fold ? path.replace(/\\/g, '/') : path).split('/');
  const out: string[] = [];
  for (let seg of raw) {
    if (fold) seg = seg.replace(/;.*$/, '');
    if (seg === '') continue;
    if (resolveDots && seg === '.') continue;
    if (resolveDots && seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`.toLowerCase();
}

/**
 * Every reading of a request URI's path that matters, the edge's first. Null
 * when the path cannot be read safely (the caller refuses).
 */
export function appPathReadings(uri: string): string[] | null {
  const cut = uri.search(/[?#]/);
  const decoded = decodeOnce(cut >= 0 ? uri.slice(0, cut) : uri);
  if (decoded === null) return null;
  const all = [segments(decoded, true, false), segments(decoded, false, false), segments(decoded, true, true), segments(decoded, false, true)];
  return [...new Set(all)];
}

/** The most specific rule covering a (normalised) path, or null. */
export function closestAppPathRule(rules: readonly AppPathRule[], path: string): AppPathRule | null {
  let best: AppPathRule | null = null;
  let bestLen = -1;
  for (const r of rules) {
    const key = ruleKey(r.path);
    if (key === null) continue;
    const covers = key === '/' || path === key || path.startsWith(`${key}/`);
    if (covers && key.length > bestLen) {
      best = r;
      bestLen = key.length;
    }
  }
  return best;
}

export function appPathRuleAdmits(rule: AppPathRule, who: AppPathPrincipal): boolean {
  if (rule.everyone) return true;
  if (rule.roles?.includes(who.role as AppPathRole)) return true;
  if (rule.groups?.some((g) => who.groups.includes(g))) return true;
  return Boolean(who.memberId && rule.people?.includes(who.memberId));
}

export type AppPathDecision =
  | { admit: true; rule: string | null }
  | { admit: false; reason: 'rules' | 'unreadable-path' | 'path'; rule: string | null };

/** May this person (already admitted to the app) open this URI? */
export function decideAppPath(raw: unknown, uri: string, who: AppPathPrincipal): AppPathDecision {
  const rules = parseAppPathRules(raw);
  if (rules === null) return { admit: false, reason: 'rules', rule: null };
  if (rules.length === 0) return { admit: true, rule: null };
  const readings = appPathReadings(uri);
  if (readings === null) return { admit: false, reason: 'unreadable-path', rule: null };
  let decided: string | null = null;
  for (const path of readings) {
    const rule = closestAppPathRule(rules, path);
    if (!rule) continue;
    if (!appPathRuleAdmits(rule, who)) return { admit: false, reason: 'path', rule: rule.path };
    decided ??= rule.path;
  }
  return { admit: true, rule: decided };
}
