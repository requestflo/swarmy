/**
 * Clone as a new environment (board Environments): a LONG-LIVED environment
 * the dashboard declares, not a preview — the same swarmy.yaml as the
 * environment it was cloned from, tracking its own branch, as its own stack
 * `<app>-<name>`. swarmy can't write to the repo, so it lives in the
 * dashboard (its AppPlan rows carry this marker) until someone adds
 * `environments.<name>` to swarmy.yaml; from then on the file decides.
 *
 * Rules (PURE; `cloneDesired` returns a normal DesiredApp the planner needs
 * no special case for):
 *   - It inherits `from`'s overrides (none for production) but never a
 *     hostname: production's are dropped by `resolveEnvironment`, and a
 *     named environment's own domains stay with it. Each service production
 *     serves on a domain gets the clone's own stable address instead
 *     (`hostFor`), so the clone is reachable the moment it deploys.
 *   - Secrets are NEVER copied. Every secret the app reads (`secrets: [x]`,
 *     `KEY: ${{ secrets.x }}`) becomes an empty slot: the environment's own
 *     Docker secret family `<x>.<name>`, filled write-only from the dashboard.
 *     The plan wires none of them, so a clone deploys before they're set.
 *   - `data` starts its Postgres as a COPY of `from`'s newest backup (the
 *     previews-with-data path), masked by `previews.data.scrub` when asked.
 */
import { extractBindings, refKey } from './bindings';
import { toDesired, type DesiredApp, type DesiredOptions, type DesiredService } from './desired';
import { environmentStack, PRODUCTION } from './environments';
import { signature } from './hash';
import { ENV_NAME_RE, RESERVED_ENV_NAMES, type AppConfig } from './schema';

export interface DashboardEnvironment {
  name: string;
  branch: string;
  /** The environment it is a clone of (`production` or a named one). */
  from: string;
  /** Start its Postgres from `from`'s newest backup; `mask` runs `previews.data.scrub` on the copy. */
  data?: { mask: boolean };
}

export interface SecretSlot {
  /** The name swarmy.yaml uses (`stripe-key`). */
  family: string;
  /** This environment's own family — `<family>.<env>`, never a copy of another's. */
  envFamily: string;
  /** Who reads it: a file at /run/secrets/<family>, or an env var by name. */
  consumers: Array<{ service: string; envName?: string }>;
}

/** What a dashboard environment's DesiredApp (and so its AppPlan rows) records about it. */
export interface DashboardEnvMarker {
  branch: string;
  from: string;
  data?: { mask: boolean };
  secretSlots: SecretSlot[];
}

export const envSecretFamily = (family: string, env: string): string => `${family}.${env}`;

/** Why `name` can't be a new environment of this app, or null. */
export function cloneNameProblem(cfg: AppConfig, name: string, taken: readonly string[] = []): string | null {
  if (!ENV_NAME_RE.test(name)) return 'an environment name is lowercase letters, digits and -, up to 20, starting with a letter';
  if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) return `"${name}" is reserved — pick another name`;
  if (cfg.environments?.[name]) return `${name} is already in swarmy.yaml — push to its branch to deploy it`;
  if (taken.includes(name)) return `${cfg.app} already has an environment called ${name}`;
  return null;
}

const wholeSecret = (v: string): string | null => {
  const b = extractBindings(v);
  const ref = b.length === 1 ? b[0]!.ref : null;
  return ref?.ns === 'secret' && v.trim().startsWith('${{') && v.trim().endsWith('}}') ? ref.name : null;
};

/** Drop every secret a service reads; report each as a slot. */
function withoutSecrets(s: DesiredService, slots: Map<string, SecretSlot>, env: string): DesiredService {
  const slot = (family: string) =>
    slots.get(family) ?? slots.set(family, { family, envFamily: envSecretFamily(family, env), consumers: [] }).get(family)!;
  for (const family of s.secrets) slot(family).consumers.push({ service: s.name });
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.env)) {
    const family = wholeSecret(v);
    if (family) slot(family).consumers.push({ service: s.name, envName: k });
    else kept[k] = v;
  }
  const bindings = new Set<string>();
  for (const v of Object.values(kept)) for (const b of extractBindings(v)) if (b.ref) bindings.add(refKey(b.ref));
  const { sig: _sig, ...unit } = { ...s, env: kept, secrets: [], bindings: [...bindings].sort() };
  return { ...unit, sig: signature(unit) };
}

/**
 * The clone's desired app. Throws a plain-words Error when it can't be cloned
 * as asked. `hostFor` gives each service production serves on a domain its
 * own stable address in this environment (the controller passes
 * `<service>-<stack>.<the org's address base>`); without it, no routes.
 */
export function cloneDesired(cfg: AppConfig, clone: DashboardEnvironment, opts: Pick<DesiredOptions, 'hostFor'> = {}): DesiredApp {
  const source = clone.from === PRODUCTION ? undefined : cfg.environments?.[clone.from];
  if (clone.from !== PRODUCTION && !source) throw new Error(`no environment named "${clone.from}" to clone`);
  const services = source?.services
    ? Object.fromEntries(Object.entries(source.services).map(([n, { domains: _d, ...o }]) => [n, o]))
    : undefined;
  const def = { ...(source ?? {}), branch: clone.branch, ...(services ? { services } : {}) };
  const withEnv: AppConfig = { ...cfg, environments: { ...(cfg.environments ?? {}), [clone.name]: def } };
  const base = toDesired(withEnv, { environment: clone.name, ...(opts.hostFor ? { hostFor: opts.hostFor } : {}) });

  const slots = new Map<string, SecretSlot>();
  const svcs = base.services.map((s) => withoutSecrets(s, slots, clone.name));
  const scrub = cfg.previews?.data?.scrub;
  if (clone.data?.mask && !scrub) throw new Error('there is no mask step: add previews.data.scrub (a .sql file) to swarmy.yaml first');
  const copy = clone.data && base.resources.some((r) => r.type === 'postgres');
  return {
    ...base,
    services: svcs,
    ...(copy
      ? {
          previewData: {
            fromStack: environmentStack(cfg.app, clone.from),
            fromEnvironment: clone.from,
            ...(clone.data?.mask && scrub ? { scrub } : {}),
          },
        }
      : {}),
    dashboard: {
      branch: clone.branch,
      from: clone.from,
      ...(clone.data ? { data: { mask: clone.data.mask } } : {}),
      secretSlots: [...slots.values()].sort((a, b) => a.family.localeCompare(b.family)),
    },
  };
}

/** The swarmy.yaml lines that make a dashboard environment part of the file. */
export function cloneYaml(name: string, branch: string): string {
  return `environments:\n  ${name}:\n    branch: ${/^[\w./-]+$/.test(branch) ? branch : JSON.stringify(branch)}\n`;
}
