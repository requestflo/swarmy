/**
 * Reading a Heroku app for {@link fromHeroku} — pure and forgiving: `app.json`
 * (formation, addons, env, scripts, buildpacks, Dokku-style `cron`), a
 * Procfile, and `heroku config` output in any of its three shapes (the
 * default table, `--shell`, `--json`). Nothing here throws on bad input.
 */
import { parseDotenv } from '@swarmy/core';
import { isCron } from './units';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export interface HerokuEnvSpec {
  value?: string;
  description?: string;
  required: boolean;
  /** `generator: "secret"` — Heroku made a random value at app creation. */
  generated: boolean;
}

export interface HerokuAddon {
  /** The add-on service: `heroku-postgresql`. */
  service: string;
  /** The plan after the colon: `standard-0`. */
  plan?: string;
  /** Attachment name (`as:`): its config var is `<AS>_URL`. */
  as?: string;
  options: Obj;
  /** As written, for the gap list. */
  raw: string;
}

export interface HerokuAppJson {
  name?: string;
  stack?: string;
  env: Record<string, HerokuEnvSpec>;
  formation: Record<string, { quantity?: number; size?: string }>;
  addons: HerokuAddon[];
  buildpacks: string[];
  scripts: Record<string, string>;
  cron: Array<{ command: string; schedule: string }>;
  environments: string[];
}

/** `app.json` text → its parts, or an error sentence. */
export function readAppJson(text: string): { json: HerokuAppJson } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `app.json isn't valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  const o = obj(raw);
  if (!o) return { error: 'app.json is not a JSON object' };
  const env: Record<string, HerokuEnvSpec> = {};
  for (const [k, v] of Object.entries(obj(o.env) ?? {})) {
    const spec = obj(v);
    const value = typeof v === 'string' ? v : spec && spec.value !== undefined && spec.value !== null ? String(spec.value) : undefined;
    env[k] = { ...(value !== undefined ? { value } : {}), ...(str(spec?.description) ? { description: str(spec?.description) } : {}), required: spec?.required === true, generated: spec?.generator === 'secret' };
  }
  const formation: HerokuAppJson['formation'] = {};
  for (const [k, v] of Object.entries(obj(o.formation) ?? {})) {
    const f = obj(v) ?? {};
    formation[k] = { ...(typeof f.quantity === 'number' ? { quantity: f.quantity } : {}), ...(str(f.size) ? { size: str(f.size)!.toLowerCase() } : {}) };
  }
  const addons = (Array.isArray(o.addons) ? o.addons : []).flatMap((a): HerokuAddon[] => {
    const spec = typeof a === 'string' ? { plan: a } : obj(a);
    const plan = str(spec?.plan);
    if (!plan) return [];
    const [service, tier] = plan.split(':');
    return [{ service: service!.toLowerCase(), ...(tier ? { plan: tier.toLowerCase() } : {}), ...(str(spec?.as) ? { as: str(spec?.as)!.toUpperCase() } : {}), options: obj(spec?.options) ?? {}, raw: plan }];
  });
  const buildpacks = (Array.isArray(o.buildpacks) ? o.buildpacks : []).flatMap((b) => str(obj(b)?.url) ?? str(b) ?? []);
  const scripts = Object.fromEntries(Object.entries(obj(o.scripts) ?? {}).flatMap(([k, v]) => (str(v) ? [[k, str(v)!]] : [])));
  const cron = (Array.isArray(o.cron) ? o.cron : []).flatMap((c) => {
    const command = str(obj(c)?.command);
    const schedule = str(obj(c)?.schedule);
    return command && schedule ? [{ command, schedule }] : [];
  });
  return {
    json: { ...(str(o.name) ? { name: str(o.name) } : {}), ...(str(o.stack) ? { stack: str(o.stack) } : {}), env, formation, addons, buildpacks, scripts, cron, environments: Object.keys(obj(o.environments) ?? {}) },
  };
}

/** `name: command` lines of a Procfile, in order (comments and junk skipped). */
export function readProcfile(text: string): Array<{ name: string; command: string }> {
  return text.split(/\r?\n/).flatMap((line) => {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
    return m && !line.trim().startsWith('#') ? [{ name: m[1]!, command: m[2]!.trim() }] : [];
  });
}

/** `heroku config` output → name → value: the `=== app Config Vars` table, `--shell` or `--json`. */
export function readHerokuConfig(text: string): Record<string, string> {
  const t = text.trim();
  if (!t) return {};
  if (t.startsWith('{')) {
    try {
      const o = obj(JSON.parse(t)) ?? {};
      return Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v === null || v === undefined ? [] : [[k, String(v)]])));
    } catch {
      return {};
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => !l.startsWith('==='));
  if (lines.some((l) => /^[A-Za-z_][A-Za-z0-9_]*:\s/.test(l)) && !lines.some((l) => /^(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/.test(l))) {
    return Object.fromEntries(lines.flatMap((l) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(l);
      return m ? [[m[1]!, m[2]!.trim()]] : [];
    }));
  }
  return Object.fromEntries(parseDotenv(lines.join('\n')).entries.map((e) => [e.key, e.value]));
}

/** Heroku dyno size → memory (MB). */
const DYNO_MB: Record<string, number> = {
  free: 512, eco: 512, hobby: 512, basic: 512, 'standard-1x': 512,
  'standard-2x': 1024, 'private-s': 1024, 'shield-s': 1024,
  'performance-m': 2560, 'private-m': 2560, 'shield-m': 2560,
  'performance-l': 14336, 'private-l': 14336, 'shield-l': 14336,
  'performance-l-ram': 30720, 'private-l-ram': 30720, 'shield-l-ram': 30720,
  'performance-xl': 63488, 'private-xl': 63488, 'shield-xl': 63488,
  'performance-2xl': 129024, 'private-2xl': 129024, 'shield-2xl': 129024,
};

/** A dyno size as swarmy.yaml keys: a preset where one matches, else `memory:`. */
export function dynoSize(size: string): { size: 'small' | 'medium' } | { memory: string } | null {
  const mb = DYNO_MB[size];
  if (!mb) return null;
  if (mb === 512) return { size: 'small' };
  if (mb === 1024) return { size: 'medium' };
  return { memory: mb % 1024 === 0 ? `${mb / 1024}gb` : `${mb}mb` };
}

const MACROS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

/** A cron schedule swarmy.yaml accepts (`@daily` → `0 0 * * *`), or null. */
export function cronSchedule(s: string): string | null {
  const v = MACROS[s.trim().toLowerCase()] ?? s.trim();
  return isCron(v) ? v : null;
}

/** Lower-kebab unit name, unique within `taken` (`urgent_worker` → `urgent-worker`). */
export function claimName(raw: string, taken: Set<string>, fallback: string): string {
  const n = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').slice(0, 30).replace(/-+$/, '') || fallback;
  let out = n;
  for (let i = 2; taken.has(out); i++) out = `${n.slice(0, 27)}-${i}`;
  taken.add(out);
  return out;
}
