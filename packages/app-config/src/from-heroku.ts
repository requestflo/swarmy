/**
 * Import a Heroku app into a starter swarmy.yaml (the roadmap's Heroku
 * importer; Heroku is in sustaining mode). Pure: `app.json`, the Procfile and
 * optionally `heroku config` output in; swarmy.yaml text out, with what
 * changed shape (`changes`) and what didn't come across, each with why
 * (`untranslated`). The result always goes back through `parseAppConfig`.
 *
 *   web            → services.web, on $PORT like Heroku (PORT = port:)
 *   other process  → a worker (a clock/scheduler process: one copy)
 *   release        → services.web.release (before each deploy, new image)
 *   formation      → replicas + size/memory
 *   add-ons        → managed postgres / cache, their URLs as bindings
 *   cron (Dokku)   → jobs:
 *   buildpacks     → build: { type: railpack }
 *   config vars    → env:, secret-looking ones as ${{ secrets.<name> }}
 *   domains        → services.web.domains (custom ones; *.herokuapp.com stays)
 *
 * Data never moves here: {@link herokuMigrationSteps} says how.
 */
import { Document } from 'yaml';
import { parseAppConfig } from './parse';
import { appName } from './from-compose-read';
import { convertAddons, inferAddons, type HerokuDatabase, type HerokuGap } from './from-heroku-addons';
import { convertBuildpacks } from './from-heroku-build';
import { convertDomains } from './from-heroku-domains';
import { convertEnv, type HerokuSecret } from './from-heroku-env';
import { herokuExtras, herokuServices } from './from-heroku-procs';
import { readAppJson, readHerokuConfig, readProcfile, type HerokuAppJson } from './from-heroku-read';

export type { HerokuDatabase, HerokuGap } from './from-heroku-addons';
export type { HerokuSecret } from './from-heroku-env';

export interface HerokuInput {
  /** `app.json` text. */
  appJson?: string;
  /** `Procfile` text. */
  procfile?: string;
  /** `heroku config` output: the table, `--shell` or `--json`. */
  config?: string;
  /** The swarmy app name (default: app.json's name, else `my-app`). */
  app?: string;
  /** The app's folder in the repo ('' = the root): the build path. */
  dir?: string;
  /** The app's hostnames (`heroku domains`, or the Platform API's). */
  domains?: string[];
}

export interface HerokuConversion {
  /** The swarmy.yaml text, or null when the input couldn't be read. */
  yaml: string | null;
  app: string;
  /** Everything worth saying, in order: the changes and the gaps. */
  notes: string[];
  changes: string[];
  untranslated: HerokuGap[];
  /** Config vars the file reads as swarmy secrets (their values are never in the file). */
  secrets: HerokuSecret[];
  /** Managed Postgres the Heroku data restores into. */
  databases: HerokuDatabase[];
  /** Variables swarmy's bindings fill in: Heroku's values for them must not come across. */
  bound: string[];
  /** Custom domains, routed to web. */
  domains: string[];
  /** Add-on variable → the binding that fills it (`DATABASE_URL` → `${{ db.url }}`). */
  bindings: Record<string, string>;
}

export const herokuGapSentence = (g: HerokuGap): string => `${g.key} isn't carried over — ${g.reason}.`;

const EMPTY: HerokuAppJson = { env: {}, formation: {}, addons: [], buildpacks: [], scripts: {}, cron: [], environments: [] };
const HEADER = ' Imported from Heroku (app.json + Procfile) by swarmy — review it, then commit it.\n Secret values stay out of git: the file reads them as ${{ secrets.<name> }}.';

export function fromHeroku(input: HerokuInput): HerokuConversion {
  const out: HerokuConversion = { yaml: null, app: appName(input.app ?? 'my-app'), notes: [], changes: [], untranslated: [], secrets: [], databases: [], bound: [], domains: [], bindings: {} };
  const change = (...xs: string[]): void => {
    out.changes.push(...xs);
    out.notes.push(...xs);
  };
  const gap = (...gs: HerokuGap[]): void => {
    out.untranslated.push(...gs);
    out.notes.push(...gs.map(herokuGapSentence));
  };
  let json = EMPTY;
  if (input.appJson?.trim()) {
    const r = readAppJson(input.appJson);
    if ('error' in r) return { ...out, notes: [`${r.error}.`] };
    json = r.json;
  }
  const procs = readProcfile(input.procfile ?? '');
  if (!input.appJson?.trim() && procs.length === 0) return { ...out, notes: ['Neither app.json nor a Procfile says what the app runs.'] };
  const config = readHerokuConfig(input.config ?? '');
  const app = appName(input.app ?? json.name ?? 'my-app');

  const dir = (input.dir ?? '').replace(/^\.?\/*|\/+$/g, '');
  const build = convertBuildpacks(json.buildpacks, dir || '.');
  const taken = new Set<string>(['web']);
  const svc = herokuServices(procs, json, build.build, taken);
  const addons = convertAddons(inferAddons(json.addons, config), taken);
  const pg = addons.databases.length === 1 ? addons.databases[0]!.resource : undefined;
  const cache = Object.entries(addons.resources).find(([, r]) => r === 'cache')?.[0];
  const aliases: Array<[RegExp, string]> = [
    ...(pg ? [[/^HEROKU_POSTGRESQL_[A-Z]+_URL$/, `\${{ ${pg}.url }}`] as [RegExp, string]] : []),
    ...(cache ? [[/^HEROKU_REDIS_[A-Z]+_URL$/, `\${{ ${cache}.url }}`] as [RegExp, string]] : []),
  ];
  const env = convertEnv({ spec: json.env, config, bindings: addons.bindings, aliases });
  const extras = herokuExtras(json, addons.scheduler);
  const hosts = convertDomains(input.domains ?? []);
  if (hosts.domains.length) svc.services.web!.domains = hosts.domains;
  change(...build.changes, ...svc.changes, ...hosts.changes, ...addons.changes, ...extras.changes, ...env.changes);
  gap(...build.gaps, ...svc.gaps, ...hosts.gaps, ...addons.gaps, ...extras.gaps, ...env.gaps);

  const file: Record<string, unknown> = {
    version: 1,
    app,
    ...(Object.keys(env.env).length ? { env: env.env } : {}),
    services: svc.services,
    ...(Object.keys(addons.resources).length ? { resources: addons.resources } : {}),
    ...(Object.keys(extras.jobs).length ? { jobs: extras.jobs } : {}),
    ...(extras.previews ? { previews: { enabled: true } } : {}),
  };
  const doc = new Document(file, { aliasDuplicateObjects: false });
  doc.commentBefore = HEADER;
  const yaml = doc.toString({ lineWidth: 0 });
  for (const issue of parseAppConfig(yaml).issues) {
    if (issue.severity === 'error') out.notes.push(`Needs a fix before it deploys: ${issue.message}`);
  }
  const bound = Object.keys(env.env).filter((k) => addons.bindings[k] || aliases.some(([re]) => re.test(k)));
  return { ...out, yaml, app, secrets: env.secrets, databases: addons.databases, bound, domains: hosts.domains, bindings: addons.bindings };
}
