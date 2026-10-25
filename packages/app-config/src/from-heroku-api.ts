/**
 * A Heroku app read through the Platform API → {@link fromHeroku}'s input.
 * Pure: the controller fetches (it alone holds the token), this only reshapes
 * the JSON into the app.json + Procfile + config the importer already reads.
 *
 *   GET /apps/{app}                          name, stack
 *   GET /apps/{app}/formation                process types: quantity, size, command
 *   GET /apps/{app}/slugs/{current}          process_types (the Procfile, release too)
 *   GET /apps/{app}/addons                   plan + the config vars each one sets
 *   GET /apps/{app}/buildpack-installations  buildpacks, in order
 *   GET /apps/{app}/config-vars              config vars
 *   GET /apps/{app}/domains                  hostnames
 *
 * Heroku Scheduler's jobs are not in the Platform API: the importer says so.
 */
import type { HerokuGap } from './from-heroku-addons';
import type { HerokuInput } from './from-heroku';

export interface HerokuApiSnapshot {
  app: { name: string; stack?: { name?: string } | null };
  formation: Array<{ type: string; quantity?: number; size?: string; command?: string }>;
  /** The current release's slug `process_types`; null when the release has no slug. */
  processTypes: Record<string, string> | null;
  addons: Array<{ addon_service?: { name?: string }; plan?: { name?: string }; config_vars?: string[] }>;
  buildpacks: Array<{ buildpack?: { url?: string; name?: string } }>;
  configVars: Record<string, string | null>;
  domains: Array<{ hostname?: string; kind?: string }>;
}

/** The attachment var an add-on answers to: DATABASE_URL beats its HEROKU_POSTGRESQL_<COLOR>_URL alias. */
const PRIMARY_VAR: Record<string, string> = { 'heroku-postgresql': 'DATABASE_URL', 'heroku-redis': 'REDIS_URL' };

function addonAs(service: string, vars: readonly string[]): string | undefined {
  const urls = vars.filter((v) => v.endsWith('_URL') && v !== 'REDIS_TLS_URL');
  const primary = PRIMARY_VAR[service];
  if (primary && (urls.includes(primary) || urls.length === 0)) return undefined;
  return urls[0]?.replace(/_URL$/, '');
}

export interface HerokuApiInput {
  input: HerokuInput;
  /** What the API couldn't say, in the importer's words. */
  gaps: HerokuGap[];
}

export function herokuApiInput(snap: HerokuApiSnapshot): HerokuApiInput {
  const gaps: HerokuGap[] = [];
  const formation = Object.fromEntries(
    snap.formation.map((f) => [f.type, { ...(typeof f.quantity === 'number' ? { quantity: f.quantity } : {}), ...(f.size ? { size: f.size } : {}) }]),
  );
  const addons = snap.addons.flatMap((a) => {
    const plan = a.plan?.name;
    if (!plan) return [];
    const as = addonAs(a.addon_service?.name ?? plan.split(':')[0]!, a.config_vars ?? []);
    return [as ? { plan, as } : { plan }];
  });
  // The attachment that answers to DATABASE_URL goes first: it is the app's `db`.
  addons.sort((a, b) => Number('as' in a) - Number('as' in b));
  const buildpacks = snap.buildpacks.flatMap((b) => {
    const url = b.buildpack?.url ?? b.buildpack?.name;
    return url ? [{ url }] : [];
  });
  const appJson = { name: snap.app.name, ...(snap.app.stack?.name ? { stack: snap.app.stack.name } : {}), formation, addons, buildpacks };

  const procs = snap.processTypes ?? Object.fromEntries(snap.formation.flatMap((f) => (f.command ? [[f.type, f.command]] : [])));
  if (!snap.processTypes) {
    gaps.push({
      key: 'release',
      reason: 'the current release has no slug to read the Procfile from, so the commands come from the formation and a release phase can’t be seen: add release: under services.web if the app has one',
    });
  }
  const procfile = Object.entries(procs)
    .map(([type, command]) => `${type}: ${command.replace(/\r?\n/g, ' ')}`)
    .join('\n');
  const config = JSON.stringify(Object.fromEntries(Object.entries(snap.configVars).filter(([, v]) => v !== null)));
  // Heroku's own *.herokuapp.com name goes in too: the importer lists it as staying behind.
  const domains = snap.domains.flatMap((d) => (d.hostname ? [d.hostname] : []));
  return { input: { appJson: JSON.stringify(appJson), procfile, config, app: snap.app.name, domains }, gaps };
}
