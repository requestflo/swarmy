/**
 * The Heroku import as a plan in plain words: what each process becomes,
 * what data swarmy runs, which config is sealed, which domains move and
 * what's left to do. Pure; read off the converted swarmy.yaml (through the
 * same parser + `toDesired` a push runs), so the plan says what will happen.
 */
import { toDesired, type DesiredApp } from './desired';
import type { HerokuConversion, HerokuGap, HerokuSecret } from './from-heroku';
import { parseAppConfig } from './parse';

export interface HerokuPlanItem {
  name: string;
  /** The sentence (no glossary words). */
  say: string;
  /** The swarmy.yaml it comes from (Controls). */
  tech: string;
}

export interface HerokuPlanService extends HerokuPlanItem {
  role: 'web' | 'worker' | 'clock';
}

export interface HerokuPlanData extends HerokuPlanItem {
  kind: 'postgres' | 'cache';
  /** The Heroku variable now bound to it (`DATABASE_URL`). */
  envVar?: string;
}

export interface HerokuImportPlan {
  app: string;
  headline: string;
  services: HerokuPlanService[];
  data: HerokuPlanData[];
  /** Plain config vars written into swarmy.yaml. */
  plainVars: string[];
  /** Secret-looking vars: sealed as swarmy secrets, never in the file. */
  secrets: HerokuSecret[];
  /** Vars swarmy fills in itself (add-on URLs). */
  bound: string[];
  domains: string[];
  jobs: HerokuPlanItem[];
  /** Didn't come across: each says what to do. */
  todo: HerokuGap[];
  /** swarmy covers these itself. */
  handled: HerokuGap[];
}

const CLOCK = /^(clock|scheduler|beat|cron)/;
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const gb = (mb: number): string => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
const and = (xs: readonly string[]): string => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''));
const text = (c: unknown): string => (Array.isArray(c) ? c.join(' ') : typeof c === 'string' ? c : '');

function serviceItems(d: DesiredApp, cfg: Record<string, { command?: unknown; release?: unknown }>): HerokuPlanService[] {
  return d.services.map((s) => {
    const role = s.name === 'web' ? 'web' : CLOCK.test(s.name) ? 'clock' : 'worker';
    const hosts = d.routes.filter((r) => r.service === s.name).map((r) => r.host);
    const what = role === 'web' ? `Answers on its address${hosts.length ? `, ${and(hosts)}` : ''}` : role === 'clock' ? 'Keeps its own schedule' : 'Background work, no address';
    const size = s.memoryMb ? `${s.cpu ? `${s.cpu} CPU, ` : ''}${gb(s.memoryMb)} each` : 'no size limit';
    const release = text(cfg[s.name]?.release);
    const say = `${what}: ${count(s.replicas, 'copy', 'copies')}, ${size}.${release ? ` Runs “${release}” before each deploy.` : ''}`;
    const tech = [`services.${s.name}`, text(cfg[s.name]?.command) || 'start detected', ...(s.port ? [`port ${s.port}`] : []), `replicas ${s.replicas}`].join(' · ');
    return { name: s.name, role, say, tech };
  });
}

function dataItems(d: DesiredApp, conv: HerokuConversion): HerokuPlanData[] {
  return d.resources.flatMap((r): HerokuPlanData[] => {
    const envVar = Object.entries(conv.bindings).find(([, b]) => b === `\${{ ${r.name}.url }}`)?.[0];
    const points = envVar ? ` ${envVar} points at it.` : '';
    if (r.type === 'postgres') {
      const standby = r.ha === 'single' ? '' : ', with a standby copy that takes over';
      return [{ name: r.name, kind: 'postgres', envVar, say: `A Postgres ${r.version} database${standby}, backed up nightly.${points}`, tech: `resources.${r.name} · postgres ${r.version} · ha ${r.ha}` }];
    }
    if (r.type === 'cache') return [{ name: r.name, kind: 'cache', envVar, say: `A cache (Valkey, which speaks Redis) on the app’s private network.${points}`, tech: `resources.${r.name} · ${r.engine} · ${r.ha}` }];
    return [];
  });
}

/**
 * The gaps, with each secret the import's Deploy seals (its value is known)
 * moved to "swarmy does this itself": nothing left to create by hand.
 */
export function sealedGaps(conv: HerokuConversion, sealed: readonly string[]): HerokuGap[] {
  const byKey = new Map(conv.secrets.filter((s) => sealed.includes(s.name)).map((s) => [s.key, s.name]));
  return conv.untranslated.map((g) => {
    const name = byKey.get(g.key.replace(/^(config|env)\./, ''));
    return name && /^(config|env)\./.test(g.key) ? { key: g.key, reason: `Deploy seals it as the swarmy secret ${name} with Heroku’s value (the file reads \${{ secrets.${name} }})`, handled: true } : g;
  });
}

/** The plan; `sealed` = the secrets Deploy will seal with Heroku's values. */
export function herokuImportPlan(conv: HerokuConversion, sealed: readonly string[] = []): HerokuImportPlan | null {
  const parsed = conv.yaml ? parseAppConfig(conv.yaml) : null;
  if (!parsed?.config) return null;
  const d = toDesired(parsed.config);
  const gaps = sealedGaps(conv, sealed);
  const services = serviceItems(d, parsed.config.services as Record<string, { command?: unknown; release?: unknown }>);
  const data = dataItems(d, conv).sort((a, b) => Number(a.kind !== 'postgres') - Number(b.kind !== 'postgres'));
  const secretKeys = new Set(conv.secrets.map((s) => s.key));
  const plainVars = Object.keys(parsed.config.env ?? {}).filter((k) => !secretKeys.has(k) && !conv.bound.includes(k) && k !== 'HEROKU_APP_NAME');
  const jobs = d.jobs.map((j) => ({ name: j.name, say: `Runs “${text(j.command.slice(-1))}” on “${j.schedule}”.`, tech: `jobs.${j.name}` }));
  const parts = [count(services.length, 'service'), ...data.map((x) => (x.kind === 'postgres' ? 'a Postgres database' : 'a cache'))];
  return {
    app: conv.app,
    headline: `${conv.app} comes across as ${and(parts)}.`,
    services,
    data,
    plainVars,
    secrets: conv.secrets,
    bound: conv.bound,
    domains: conv.domains,
    jobs,
    todo: gaps.filter((g) => !g.handled),
    handled: gaps.filter((g) => g.handled),
  };
}
