/**
 * The Procfile + `formation` → swarmy services, and app.json's scheduled
 * jobs, scripts and environments → jobs, previews or gaps. For
 * {@link fromHeroku}; pure.
 */
import type { HerokuGap } from './from-heroku-addons';
import { dynoLimitsText, dynoSize } from './from-heroku-dyno';
import { claimName, cronSchedule, type HerokuAppJson } from './from-heroku-read';

/** A clock process runs its own schedule: one copy, so each job fires once. */
const CLOCK = /^(clock|scheduler|beat|cron)$/;
/** `heroku local`'s default. Any port works: the app reads $PORT and swarmy sets PORT to it. */
export const HEROKU_DEFAULT_PORT = 5000;

export interface ServicesConversion {
  services: Record<string, Record<string, unknown>>;
  changes: string[];
  gaps: HerokuGap[];
}

/** A literal port in the web command (`--port 8000`, `-b 0.0.0.0:8000`) or app.json's PORT. */
function portOf(command: string | undefined, envPort: string | undefined): number | null {
  const literal = command ? /(?:--port[=\s]|-p\s+|(?:-b|--bind)[=\s]\S*:)(\d{2,5})\b/.exec(command)?.[1] : undefined;
  const n = Number(literal ?? envPort);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export function herokuServices(
  procs: Array<{ name: string; command: string }>,
  json: HerokuAppJson,
  build: Record<string, unknown>,
  taken: Set<string>,
): ServicesConversion {
  const c: ServicesConversion = { services: {}, changes: [], gaps: [] };
  const web = procs.find((p) => p.name === 'web');
  const release = procs.find((p) => p.name === 'release');
  const found = portOf(web?.command, json.env.PORT?.value);
  const port = found ?? HEROKU_DEFAULT_PORT;
  c.services.web = { build, ...(web ? { command: web.command } : {}), port, ...(release ? { release: release.command } : {}) };
  c.changes.push(
    web
      ? `The web process becomes services.web${found ? `, on port ${port}` : `: it reads $PORT as it did on Heroku, and swarmy sets PORT=${port}`}.`
      : `There's no web process in the Procfile: Railpack starts the app the way it detects it, on PORT=${port}.`,
  );
  if (release) c.changes.push(`The release phase (${release.command}) runs before each deploy, in the new image (services.web.release).`);
  const names = new Map<string, string>([['web', 'web']]);
  for (const p of procs) {
    if (p.name === 'web' || p.name === 'release') continue;
    const name = claimName(p.name, taken, 'worker');
    names.set(p.name, name);
    const clock = CLOCK.test(p.name);
    c.services[name] = { build, command: p.command, ...(clock ? { replicas: 1 } : {}) };
    c.changes.push(
      clock
        ? `${p.name} keeps its own schedule, so services.${name} runs one copy and each job fires once.`
        : `${p.name} becomes a background worker, services.${name}, with no address.`,
    );
  }
  for (const [type, f] of Object.entries(json.formation)) {
    const name = names.get(type);
    const key = `formation.${type}`;
    if (!name) {
      c.gaps.push({ key, reason: `the Procfile has no ${type} process, so there is nothing to scale` });
      continue;
    }
    const s = c.services[name]!;
    if (f.quantity !== undefined) {
      if (CLOCK.test(type) && f.quantity > 1) c.gaps.push({ key: `${key}.quantity`, reason: 'a clock runs as one copy, so each schedule fires once' });
      else if (Number.isInteger(f.quantity) && f.quantity >= 0 && f.quantity <= 100) s.replicas = f.quantity;
      else c.gaps.push({ key: `${key}.quantity`, reason: 'swarmy runs 0 to 100 copies of a service' });
    }
    if (f.size) {
      const size = dynoSize(f.size);
      if (!size) c.gaps.push({ key: `${key}.size`, reason: `${f.size} isn't a dyno size swarmy knows: set size:, or memory: and cpu:, yourself` });
      else {
        Object.assign(s, size);
        c.changes.push(`${type} ran on ${f.size} dynos: ${dynoLimitsText(size)} per copy.`);
      }
    }
  }
  return c;
}

export interface ExtrasConversion {
  jobs: Record<string, Record<string, unknown>>;
  /** app.json has review apps → swarmy PR previews. */
  previews: boolean;
  changes: string[];
  gaps: HerokuGap[];
}

/** `bundle exec rake invoices:send` → `invoices-send`. */
const jobName = (cmd: string): string =>
  (cmd.trim().split(/\s+/).pop() ?? '').split('/').pop()!.replace(/\.[a-z0-9]+$/i, '').replace(/:/g, '-');

export function herokuExtras(json: HerokuAppJson, scheduler?: string): ExtrasConversion {
  const c: ExtrasConversion = { jobs: {}, previews: false, changes: [], gaps: [] };
  const taken = new Set<string>();
  json.cron.forEach((j, i) => {
    const schedule = cronSchedule(j.schedule);
    if (!schedule) {
      c.gaps.push({ key: `cron[${i}]: ${j.schedule}`, reason: "that isn't a five-field cron schedule (or @daily-style shorthand) swarmy.yaml can run" });
      return;
    }
    const name = claimName(jobName(j.command), taken, 'job');
    c.jobs[name] = { schedule, service: 'web', run: j.command };
    c.changes.push(`"${j.command}" runs at "${schedule}" as jobs.${name}, in web's image and env.`);
  });
  if (scheduler) {
    c.gaps.push({
      key: scheduler,
      reason: json.cron.length
        ? "Heroku Scheduler's own jobs live in its dashboard: add any that aren't under jobs: yet"
        : "Heroku Scheduler keeps its jobs in its dashboard, not app.json: add each one under jobs: with its schedule and command (they run in web's image and env)",
    });
  }
  for (const [k, cmd] of Object.entries(json.scripts)) {
    const reason =
      k === 'postdeploy'
        ? `it ran once, after Heroku first made the app, and swarmy.yaml has no one-time hook: run "${cmd}" yourself after the first deploy (release: runs on every deploy)`
        : k === 'pr-predestroy'
          ? "a preview's resources are torn down with it, so there is no hook before"
          : `swarmy.yaml has no ${k} hook`;
    c.gaps.push({ key: `scripts.${k}`, reason });
  }
  for (const e of json.environments) {
    if (e === 'review') {
      c.previews = true;
      c.changes.push('Review apps become pull-request previews (previews.enabled): each PR gets its own copy, with its own data.');
    } else c.gaps.push({ key: `environments.${e}`, reason: e === 'test' ? "Heroku CI's test setup: swarmy runs no tests, so keep them in your CI" : `swarmy.yaml has no ${e} environment from app.json: add one under environments: with the branch it tracks` });
  }
  if (json.stack) c.gaps.push({ key: `stack: ${json.stack}`, reason: 'Railpack picks its own base image', handled: true });
  return c;
}
