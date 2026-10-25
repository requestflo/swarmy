/**
 * Heroku add-ons → swarmy.yaml resources, for {@link fromHeroku}. Pure.
 *
 *  - `heroku-postgresql` → a managed `postgres` (the first is `db`, bound to
 *    DATABASE_URL; `as: X` names it and binds X_URL). Premium, Private and
 *    Shield plans have a standby on Heroku → `ha: failover`.
 *  - `heroku-redis` (and Redis Cloud / Redis To Go) → a managed `cache`.
 *  - `scheduler` is flagged: its jobs live in Heroku's dashboard.
 *  - Everything else is a gap, with what to do instead.
 */
import { DEFAULT_POSTGRES_VERSION, POSTGRES_VERSIONS } from './schema';
import { claimName, type HerokuAddon } from './from-heroku-read';

export interface HerokuGap {
  /** Where it came from, as written: `addons: papertrail`, `config.STRIPE_KEY`, `scripts.postdeploy`. */
  key: string;
  /** Why it isn't in the file, and what to do instead. */
  reason: string;
  /** swarmy does this itself, so nothing is lost. */
  handled?: true;
}

export interface HerokuDatabase {
  /** The swarmy resource (`db`). */
  resource: string;
  /** The Heroku config var it was (`DATABASE_URL`) — also the `pg:backups` attachment. */
  envVar: string;
  version: number;
}

export interface AddonConversion {
  resources: Record<string, Record<string, unknown> | string>;
  /** Config var → the binding swarmy fills in (`DATABASE_URL` → `${{ db.url }}`). */
  bindings: Record<string, string>;
  databases: HerokuDatabase[];
  /** The Scheduler add-on is attached. */
  scheduler?: string;
  changes: string[];
  gaps: HerokuGap[];
}

const PG = 'heroku-postgresql';
const REDIS: Record<string, string> = { 'heroku-redis': 'REDIS', rediscloud: 'REDISCLOUD', redistogo: 'REDISTOGO' };
const HA_PLAN = /^(premium|private|shield)-/;
const VIA_CONFIG = 'its config vars come across with heroku config';
const LOGS = { reason: "swarmy collects every service's logs itself", handled: true as const };
const APM = { reason: `a hosted monitoring add-on: keep it (${VIA_CONFIG}), or try swarmy's own error tracking with errors: true` };
const MAIL = { reason: `a hosted email add-on: keep it (${VIA_CONFIG}), or send through swarmy with email: in swarmy.yaml` };
const BROKER = { reason: `swarmy has no managed Kafka or RabbitMQ: keep the hosted one (${VIA_CONFIG}), or run it as a service` };
const KNOWN: Record<string, { reason: string; handled?: true }> = {
  papertrail: LOGS, logdna: LOGS, mezmo: LOGS, coralogix: LOGS, sumologic: LOGS, logentries: LOGS, loggly: LOGS,
  newrelic: APM, scout: APM, skylight: APM, appsignal: APM, honeybadger: APM, sentry: APM, bugsnag: APM, rollbar: APM, librato: APM,
  sendgrid: MAIL, mailgun: MAIL, postmark: MAIL, mailtrap: MAIL, sparkpost: MAIL,
  'heroku-kafka': BROKER, cloudamqp: BROKER, cloudkarafka: BROKER,
  memcachier: { reason: "swarmy's managed cache speaks Redis, not memcached: point the app's cache client at a cache resource" },
  bucketeer: { reason: 'swarmy has its own buckets (type: bucket) with their own keys: copy the files across, then bind the S3 settings to the bucket' },
  bonsai: { reason: `swarmy's search runs Meilisearch or Typesense (type: search), not Elasticsearch: keep the hosted one (${VIA_CONFIG})` },
};

const bind = (resource: string): string => `\${{ ${resource}.url }}`;

/** Add-ons app.json doesn't list but the config vars give away (a postgres:// DATABASE_URL). */
export function inferAddons(addons: HerokuAddon[], config: Record<string, string>): HerokuAddon[] {
  const out = [...addons];
  const has = (s: string): boolean => out.some((a) => a.service === s);
  if (!has(PG) && /^postgres(ql)?:\/\//i.test(config.DATABASE_URL ?? '')) out.push({ service: PG, options: {}, raw: 'DATABASE_URL (heroku config)' });
  if (!Object.keys(REDIS).some(has) && /^rediss?:\/\//i.test(config.REDIS_URL ?? '')) out.push({ service: 'heroku-redis', options: {}, raw: 'REDIS_URL (heroku config)' });
  return out;
}

export function convertAddons(addons: HerokuAddon[], taken: Set<string>): AddonConversion {
  const c: AddonConversion = { resources: {}, bindings: {}, databases: [], changes: [], gaps: [] };
  let pgSeen = false;
  let redisSeen = false;
  for (const a of addons) {
    const key = `addons: ${a.raw}`;
    if (a.service === PG) {
      const first = !pgSeen && (!a.as || a.as === 'DATABASE');
      pgSeen = true;
      const name = claimName(first ? 'db' : (a.as?.replace(/^HEROKU_POSTGRESQL_/, 'DB_') ?? 'db'), taken, 'db');
      const envVar = a.as ? `${a.as}_URL` : first ? 'DATABASE_URL' : null;
      const asked = Number(a.options.version);
      const version = (POSTGRES_VERSIONS as readonly number[]).includes(asked) ? asked : DEFAULT_POSTGRES_VERSION;
      if (a.options.version !== undefined && version !== asked) c.gaps.push({ key: `${key} (version ${String(a.options.version)})`, reason: `swarmy runs Postgres ${POSTGRES_VERSIONS.join(', ')}, so "${name}" starts on ${version}: pg_restore loads an older dump into a newer Postgres, not the other way round` });
      const ha = a.plan && HA_PLAN.test(a.plan) ? { ha: 'failover' } : {};
      c.resources[name] = { type: 'postgres', version, ...ha };
      const what = `${a.raw} becomes a managed Postgres ${version} "${name}"${'ha' in ha ? ' with a standby copy that takes over (ha: failover), as the plan had' : ''} — swarmy runs it and backs it up nightly`;
      if (envVar) {
        c.bindings[envVar] = bind(name);
        c.databases.push({ resource: name, envVar, version });
        c.changes.push(`${what}; ${envVar} is filled in at deploy.`);
      } else {
        c.changes.push(`${what}.`);
        c.gaps.push({ key, reason: `a second Heroku Postgres without as: gets a HEROKU_POSTGRESQL_<COLOR>_URL name: bind that variable to \${{ ${name}.url }} in env:, and bring its data across like ${c.databases[0]?.resource ?? 'db'}'s` });
      }
    } else if (REDIS[a.service]) {
      const name = claimName(redisSeen ? (a.as ?? 'cache') : 'cache', taken, 'cache');
      const envVar = `${a.as ?? REDIS[a.service]}_URL`;
      c.resources[name] = 'cache';
      c.bindings[envVar] = bind(name);
      if (a.service === 'heroku-redis' && !a.as && !redisSeen) c.bindings.REDIS_TLS_URL = bind(name);
      redisSeen = true;
      c.changes.push(`${a.raw} becomes a managed cache "${name}" (Valkey, Redis-compatible); ${envVar} points at it, on the app's private network.`);
    } else if (a.service === 'scheduler') {
      c.scheduler = key;
    } else {
      const known = KNOWN[a.service] ?? { reason: `${a.service} is a hosted add-on with no swarmy equivalent: keep it — ${VIA_CONFIG}` };
      c.gaps.push({ key, ...known });
    }
  }
  return c;
}
