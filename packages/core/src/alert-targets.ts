/**
 * Alert rule targets (owner decision Q10) — the one typed place the rule
 * selector contract lives. A rule watches every subject of its signal unless
 * its selector narrows it to one server, one app, or one part of an app.
 *
 * - `AlertSelector` is what a rule stores (`AlertRule.selectorJson`): an
 *   absent/empty key means "any".
 * - `AlertSubject` is what a fired condition is about, derived from the
 *   event's resource key (`subjectFromResource`) — the resource conventions
 *   the evaluator and the other slices already use.
 * - `selectorMatches` is the only matching rule: every key the selector sets
 *   must equal the subject's; an empty selector matches everything.
 *
 * Pure and browser-safe (the dashboard's sentence editor uses it too).
 */
import { ALERT_SIGNAL_INFO, type AlertTargetKind } from './views';

/** What a rule is narrowed to. Empty = any subject of the signal. */
export interface AlertSelector {
  /** App (stack) name. */
  app?: string;
  /** Server (node) name — server signals only. */
  server?: string;
  /** Part (service short name) inside `app` — needs `app`. */
  service?: string;
}

/** What one fired condition is about. */
export interface AlertSubject {
  app?: string;
  server?: string;
  service?: string;
}

const KEYS = ['app', 'server', 'service'] as const;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Parse the stored `selectorJson` column; anything malformed reads as "any". */
export function parseAlertSelector(json: unknown): AlertSelector {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  const raw = json as Record<string, unknown>;
  const out: AlertSelector = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Drop empty keys so `{ app: '' }` and `{}` are the same stored value. */
export function normalizeAlertSelector(sel: AlertSelector | null | undefined): AlertSelector {
  return parseAlertSelector(sel ?? {});
}

/** True when the selector narrows nothing. */
export function isAnyTarget(sel: AlertSelector): boolean {
  return !sel.app && !sel.server && !sel.service;
}

/** The target kind a signal's rules may use (the signal catalogue's `target`). */
export function signalTargetKind(signal: string): AlertTargetKind {
  return (ALERT_SIGNAL_INFO as Record<string, { target: AlertTargetKind } | undefined>)[signal]?.target ?? null;
}

/**
 * Why a selector is wrong for a signal, or null when it is fine. A server
 * target only for server signals; app/part targets only for app signals; a
 * part needs its app. Names are Docker-name shaped.
 */
export function validateAlertSelector(signal: string, sel: AlertSelector): string | null {
  const kind = signalTargetKind(signal);
  for (const k of KEYS) {
    const v = sel[k];
    if (v !== undefined && !NAME_RE.test(v)) return `${k} "${v}" is not a valid name`;
  }
  if (sel.server && kind !== 'server') return `${signal} alerts can't be narrowed to one server`;
  if ((sel.app || sel.service) && kind !== 'app') return `${signal} alerts can't be narrowed to one app`;
  if (sel.service && !sel.app) return 'pick the app before the part of it';
  return null;
}

/** Docker stack naming: a stack's service `shop_web` is part `web` of app `shop`. */
function splitServiceName(name: string): AlertSubject {
  const i = name.indexOf('_');
  if (i > 0 && i < name.length - 1) return { app: name.slice(0, i), service: name.slice(i + 1) };
  return { service: name };
}

/**
 * The subject of an event from its resource key — the conventions every
 * alert source uses: `node:<name>[:forecast]`, `service:<stack>_<svc>`,
 * `app:<stack>` / `stack:<stack>` / `release:<stack>`, `db:<stack>/<cluster>`,
 * `queue:<service>/<queue>`, `errors:<stack>:<fp>`. Anything else has no
 * narrower subject (only "any" rules match it).
 */
export function subjectFromResource(resource: string): AlertSubject {
  const i = resource.indexOf(':');
  if (i <= 0) return {};
  const kind = resource.slice(0, i);
  const rest = resource.slice(i + 1);
  if (!rest) return {};
  switch (kind) {
    case 'node': {
      const name = rest.split(':')[0];
      return name ? { server: name } : {};
    }
    case 'service':
      return splitServiceName(rest);
    case 'app':
    case 'stack':
    case 'release':
      return { app: rest };
    case 'errors': {
      const app = rest.split(':')[0];
      return app ? { app } : {};
    }
    case 'db': {
      const slash = rest.indexOf('/');
      return slash > 0 ? { app: rest.slice(0, slash) } : {};
    }
    case 'queue': {
      const worker = rest.split('/')[0];
      return worker ? splitServiceName(worker) : {};
    }
    default:
      return {};
  }
}

/** Does a rule's selector cover this subject? Empty selector = everything. */
export function selectorMatches(sel: AlertSelector, subject: AlertSubject): boolean {
  for (const k of KEYS) {
    const want = sel[k];
    if (want !== undefined && subject[k] !== want) return false;
  }
  return true;
}

/**
 * The target said plainly for a rule sentence: "any server" · "wkr-1" ·
 * "any app" · "storefront" · "storefront / checkout". Null when the signal has
 * no target (the sentence then has no target clause).
 */
export function describeAlertTarget(signal: string, sel: AlertSelector): string | null {
  const kind = signalTargetKind(signal);
  if (kind === 'server') return sel.server ?? 'any server';
  if (kind === 'app') {
    if (!sel.app) return 'any app';
    return sel.service ? `${sel.app} / ${sel.service}` : sel.app;
  }
  return null;
}

/** Stable text form for tech lines and keys: `server=wkr-1`, `app=shop,service=web`, `*`. */
export function selectorKey(sel: AlertSelector): string {
  const parts = KEYS.filter((k) => sel[k]).map((k) => `${k}=${sel[k]}`);
  return parts.length ? parts.join(',') : '*';
}
