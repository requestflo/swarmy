import type { ServiceSpec } from './protocol/commands';

/**
 * Secret app variables — genuinely protected, not just masked.
 *
 * A variable marked secret on a service is stored as a **Docker Swarm secret**
 * (encrypted at rest in the raft log, delivered only to that service's tasks,
 * tmpfs-mounted at `/run/secrets/<KEY>`). Its value never appears in the service
 * spec, a label, argv, a log line or the DB — `docker service inspect` shows
 * only the secret's NAME.
 *
 * Physical secrets are immutable, so each value is a version:
 * `<service>_<KEY>_v<N>` (see {@link appSecretName}) labelled
 * `swarmy.appsecret.{service,key,version,org,by}`. Rotation = create v(N+1) →
 * rolling update the service onto it (the mount path `/run/secrets/<KEY>` does
 * not change) → the app-secret GC removes vN once the update has converged and
 * the health-gate window has passed ({@link appSecretsToPrune}).
 *
 * Delivery (per variable):
 *  - `env` (default — apps "just work"): the service runs through a tiny POSIX
 *    shim ({@link SECRET_ENV_SHIM_SCRIPT}, shipped as a swarm CONFIG, not a
 *    secret — it holds no value). The shim reads each named file from the
 *    task's tmpfs, `export`s it, and `exec`s the image's original
 *    entrypoint + command. The only thing in the spec is the NAME list
 *    (`SWARMY_SECRET_ENV=A,B`). Needs `/bin/sh` in the image.
 *  - `file`: no shim; the spec gets `<KEY>_FILE=/run/secrets/<KEY>` (the
 *    convention official images — postgres, mariadb, wordpress, … — read).
 *    Works for distroless/scratch images.
 *
 * Pure + browser-safe (no node:crypto) — shared by the controller (spec
 * planning, GC decision), the agent (shim wrap at deploy time) and the dashboard.
 */

// ── labels + names ────────────────────────────────────────────────────────────

export const APP_SECRET_SERVICE_LABEL = 'swarmy.appsecret.service';
export const APP_SECRET_KEY_LABEL = 'swarmy.appsecret.key';
export const APP_SECRET_VERSION_LABEL = 'swarmy.appsecret.version';
export const APP_SECRET_ORG_LABEL = 'swarmy.appsecret.org';
/** Display name of the member who set this version ("updated 3d ago by X"). */
export const APP_SECRET_BY_LABEL = 'swarmy.appsecret.by';
/**
 * Keyed HMAC of the value (controller `SWARMY_SECRET_KEY`), so re-pasting an
 * unchanged `.env` does not rotate. Not an offline-crack oracle: without the
 * controller key the digest says nothing about the value.
 */
export const APP_SECRET_DIGEST_LABEL = 'swarmy.appsecret.digest';

/** Env var the shim reads: comma list of `/run/secrets/<NAME>` files to export. */
export const SECRET_ENV_VAR = 'SWARMY_SECRET_ENV';
/** Where the shim config is mounted inside the task. */
export const SECRET_ENV_SHIM_PATH = '/run/swarmy/secret-env.sh';
/** Immutable swarm config holding the shim (bump the suffix when the script changes). */
export const SECRET_ENV_SHIM_CONFIG = 'swarmy_secret-env-shim_v1';
/** The user's own command/args before the shim wrap (JSON `{command,args}`). */
export const SECRET_ENV_ARGV_LABEL = 'swarmy.secretenv.argv';
/**
 * Names that fell back to FILE delivery on a shell-less image (comma list):
 * the app reads `<NAME>_FILE`. Set by the agent, read by the dashboard,
 * reversed by {@link unwrapSecretEnv}.
 */
export const SECRET_ENV_FILE_LABEL = 'swarmy.secretenv.file';

/**
 * PURE — the shell-less fallback: every `secretEnv` name the spec allows
 * (`secretEnvFileFallback`) becomes `<NAME>_FILE=/run/secrets/<NAME>` (its
 * secret is already mounted there) instead of shim delivery. The plain value
 * never enters the spec. Returns the names that still need the shim (the
 * caller refuses those on a shell-less image).
 */
export function applySecretEnvFileFallback(spec: ServiceSpec): { spec: ServiceSpec; unresolved: string[] } {
  const allowed = new Set(spec.secretEnvFileFallback ?? []);
  const names = [...new Set(spec.secretEnv ?? [])];
  const fallback = names.filter((n) => allowed.has(n));
  const unresolved = names.filter((n) => !allowed.has(n));
  const { secretEnvFileFallback: _f, ...rest } = spec;
  if (fallback.length === 0) return { spec: rest, unresolved };
  const env = { ...(spec.env ?? {}) };
  for (const n of fallback) {
    delete env[n];
    env[`${n}_FILE`] = `${SECRETS_DIR}/${n}`;
  }
  const out: ServiceSpec = {
    ...rest,
    env,
    labels: { ...(spec.labels ?? {}), [SECRET_ENV_FILE_LABEL]: fallback.join(',') },
  };
  if (unresolved.length) out.secretEnv = unresolved;
  else delete out.secretEnv;
  return { spec: out, unresolved };
}

/** Names a live spec delivers as `<NAME>_FILE` because its image has no shell. */
export function secretEnvFileNames(labels: Record<string, string> | undefined): string[] {
  return (labels?.[SECRET_ENV_FILE_LABEL] ?? '').split(',').filter((n) => isEnvName(n));
}

export const SECRETS_DIR = '/run/secrets';
/** Docker caps object names at 64 chars. */
export const DOCKER_NAME_MAX = 64;

export type SecretDelivery = 'env' | 'file';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

/** Tiny stable 32-bit FNV-1a → 8 hex chars (name disambiguation only, not security). */
function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Physical Docker secret name for one version: `<service>_<KEY>_v<N>` (a
 * compose service is already `<stack>_<svc>`, so this reads
 * `<stack>_<svc>_<KEY>_v<N>`). Over Docker's 64-char cap the prefix is
 * truncated and an 8-hex hash of the full `(service, key)` keeps it unique —
 * identity always comes from the labels, never from parsing the name.
 */
export function appSecretName(service: string, key: string, version: number): string {
  const suffix = `_v${version}`;
  const full = `${service}_${key}${suffix}`;
  if (full.length <= DOCKER_NAME_MAX) return full;
  const hash = fnv8(`${service}\u0000${key}`);
  const room = DOCKER_NAME_MAX - suffix.length - hash.length - 1;
  return `${full.slice(0, room).replace(/[_.-]+$/, '')}_${hash}${suffix}`;
}

export interface AppSecretLabelsInput {
  service: string;
  key: string;
  version: number;
  orgId: string;
  by?: string | null;
  digest?: string | null;
}

export function appSecretLabels(i: AppSecretLabelsInput): Record<string, string> {
  return {
    'swarmy.managed': 'true',
    [APP_SECRET_SERVICE_LABEL]: i.service,
    [APP_SECRET_KEY_LABEL]: i.key,
    [APP_SECRET_VERSION_LABEL]: String(i.version),
    [APP_SECRET_ORG_LABEL]: i.orgId,
    ...(i.by ? { [APP_SECRET_BY_LABEL]: i.by.slice(0, 200) } : {}),
    ...(i.digest ? { [APP_SECRET_DIGEST_LABEL]: i.digest } : {}),
  };
}

/** One physical app-secret version, decoded off a `secret.list` row's labels. */
export interface AppSecretVersion {
  name: string;
  service: string;
  key: string;
  version: number;
  createdAt: number;
  by: string | null;
  digest: string | null;
}

/** Decode the app-secret rows of a `secret.list` result (org-scoped). */
export function decodeAppSecrets(
  secrets: readonly { name: string; createdAt: number; labels?: Record<string, string> }[],
  orgId: string,
): AppSecretVersion[] {
  const out: AppSecretVersion[] = [];
  for (const s of secrets) {
    const l = s.labels ?? {};
    const service = l[APP_SECRET_SERVICE_LABEL];
    const key = l[APP_SECRET_KEY_LABEL];
    if (!service || !key) continue;
    if (l[APP_SECRET_ORG_LABEL] && l[APP_SECRET_ORG_LABEL] !== orgId) continue;
    const version = Number.parseInt(l[APP_SECRET_VERSION_LABEL] ?? '', 10);
    out.push({
      name: s.name,
      service,
      key,
      version: Number.isSafeInteger(version) && version > 0 ? version : 1,
      createdAt: s.createdAt,
      by: l[APP_SECRET_BY_LABEL] ?? null,
      digest: l[APP_SECRET_DIGEST_LABEL] ?? null,
    });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service) || a.key.localeCompare(b.key) || b.version - a.version);
}

// ── the env shim ─────────────────────────────────────────────────────────────

/**
 * POSIX sh (dash / busybox ash / bash) — builtins only (no `cat`), so any image
 * with `/bin/sh` works. Reads each `/run/secrets/<NAME>` byte-for-byte (trailing
 * newlines preserved), exports it, scrubs its own variables and `exec`s the
 * original argv — PID 1 becomes the app, signals reach it unchanged.
 * A missing/unreadable secret fails the task (exit 78, EX_CONFIG) instead of
 * starting the app with an empty credential; the health gate then rolls back.
 * Nothing is echoed except the variable NAME on error.
 */
export const SECRET_ENV_SHIM_SCRIPT = `#!/bin/sh
# swarmy secret-env shim v1 — exports /run/secrets/<NAME> as $NAME for each
# NAME in $SWARMY_SECRET_ENV, then execs the original entrypoint + command.
# Values come from the task's tmpfs only: never argv, the spec, logs or disk.
set -f
IFS=','
for n in \${SWARMY_SECRET_ENV-}; do
  case "$n" in
    ''|[0-9]*|*[!A-Za-z0-9_]*) echo "swarmy: invalid secret env name" >&2; exit 78 ;;
  esac
  f="/run/secrets/$n"
  if [ ! -r "$f" ]; then echo "swarmy: secret $n is not mounted" >&2; exit 78; fi
  v=''
  l=''
  while IFS= read -r l; do v="$v$l
"; done < "$f"
  v="$v$l"
  export "$n=$v"
done
unset IFS n f v l SWARMY_SECRET_ENV
if [ "$#" -eq 0 ]; then echo "swarmy: nothing to exec (no entrypoint/command)" >&2; exit 78; fi
exec "$@"
`;

/** The image's own ENTRYPOINT / CMD (from `docker image inspect` Config). */
export interface ImageArgv {
  entrypoint: string[];
  cmd: string[];
}

export class SecretEnvError extends Error {}

/** Does wrapping this spec need the image's ENTRYPOINT/CMD (no explicit command)? */
export function needsImageArgv(spec: Pick<ServiceSpec, 'secretEnv' | 'command'>): boolean {
  return (spec.secretEnv?.length ?? 0) > 0 && !(spec.command && spec.command.length > 0);
}

/**
 * The argv the app would have run WITHOUT the shim — Docker's merge rules:
 * an explicit Command (entrypoint override) drops the image CMD; otherwise the
 * image ENTRYPOINT runs with `args` or, failing that, the image CMD.
 */
export function originalArgv(spec: Pick<ServiceSpec, 'command' | 'args'>, image: ImageArgv | null): string[] {
  if (spec.command && spec.command.length > 0) return [...spec.command, ...(spec.args ?? [])];
  if (!image) throw new SecretEnvError('image entrypoint unknown — cannot wrap the secret-env shim');
  return [...image.entrypoint, ...(spec.args && spec.args.length > 0 ? spec.args : image.cmd)];
}

/**
 * Deploy-time transform (agent): a spec asking for `secretEnv` becomes one that
 * runs `/bin/sh <shim> <original argv…>` with the shim config mounted and
 * `SWARMY_SECRET_ENV=<names>` — values stay in `/run/secrets`. Idempotent over
 * an already-wrapped spec (it is unwrapped first). A spec without `secretEnv`
 * is returned without the field. PURE.
 */
export function wrapSecretEnv(input: ServiceSpec, image: ImageArgv | null): ServiceSpec {
  const spec = unwrapSecretEnv(input);
  const names = [...new Set(spec.secretEnv ?? [])];
  // The fallback allowance is a deploy-time instruction, never Docker spec.
  const { secretEnv: _drop, secretEnvFileFallback: _fallback, ...rest } = spec;
  if (names.length === 0) return rest;

  const targets = new Set((spec.secrets ?? []).map((r) => r.target ?? r.source));
  for (const n of names) {
    if (!isEnvName(n)) throw new SecretEnvError(`"${n}" is not a valid env var name`);
    if (!targets.has(n)) {
      throw new SecretEnvError(`secret env ${n} has no secret mounted at ${SECRETS_DIR}/${n}`);
    }
  }
  const argv = originalArgv(spec, image);
  if (argv.length === 0) throw new SecretEnvError('image has no ENTRYPOINT/CMD and no command was given');

  const env = { ...(spec.env ?? {}) };
  for (const n of names) delete env[n]; // never both: the secret wins over a stale plain value
  env[SECRET_ENV_VAR] = names.join(',');

  return {
    ...rest,
    command: ['/bin/sh', SECRET_ENV_SHIM_PATH],
    args: argv,
    env,
    configs: [
      ...(spec.configs ?? []).filter((c) => c.source !== SECRET_ENV_SHIM_CONFIG),
      { source: SECRET_ENV_SHIM_CONFIG, target: SECRET_ENV_SHIM_PATH, mode: 0o444 },
    ],
    labels: {
      ...(spec.labels ?? {}),
      [SECRET_ENV_ARGV_LABEL]: JSON.stringify({ command: spec.command ?? null, args: spec.args ?? null }),
    },
  };
}

function strArr(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** Is this (live) spec running through the shim? */
export function isSecretEnvWrapped(spec: Pick<ServiceSpec, 'command' | 'labels'>): boolean {
  return (
    spec.labels?.[SECRET_ENV_ARGV_LABEL] !== undefined ||
    (spec.command?.length === 2 && spec.command[1] === SECRET_ENV_SHIM_PATH)
  );
}

/**
 * Reverse {@link wrapSecretEnv} on a live spec read back from `service
 * inspect`: restore the user's own command/args, drop the shim config ref,
 * the argv label and `SWARMY_SECRET_ENV`, and surface the names as
 * `secretEnv`. A non-wrapped spec is returned unchanged. PURE.
 */
export function unwrapSecretEnv(input: ServiceSpec): ServiceSpec {
  const spec = unwrapSecretEnvFileFallback(input);
  if (!isSecretEnvWrapped(spec)) return spec;
  const out: ServiceSpec = { ...spec };
  const labels = { ...(spec.labels ?? {}) };
  const raw = labels[SECRET_ENV_ARGV_LABEL];
  delete labels[SECRET_ENV_ARGV_LABEL];
  out.labels = labels;

  let restored = false;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { command?: unknown; args?: unknown };
      const command = strArr(parsed.command);
      const args = strArr(parsed.args);
      if (command && command.length > 0) out.command = command;
      else delete out.command;
      if (args && args.length > 0) out.args = args;
      else delete out.args;
      restored = true;
    } catch {
      restored = false;
    }
  }
  if (!restored) {
    // Corrupt/missing label: keep the baked argv as an explicit command so the
    // app still runs exactly what it ran (never double-wrap).
    const argv = spec.args ?? [];
    if (argv.length > 0) out.command = argv;
    else delete out.command;
    delete out.args;
  }

  const env = { ...(spec.env ?? {}) };
  const names = (env[SECRET_ENV_VAR] ?? '').split(',').filter((n) => n.length > 0);
  delete env[SECRET_ENV_VAR];
  if (Object.keys(env).length > 0) out.env = env;
  else delete out.env;

  const configs = (spec.configs ?? []).filter((c) => c.source !== SECRET_ENV_SHIM_CONFIG);
  if (configs.length > 0) out.configs = configs;
  else delete out.configs;

  if (names.length > 0) out.secretEnv = [...new Set([...(spec.secretEnv ?? []), ...names])];
  return out;
}

/**
 * Reverse {@link applySecretEnvFileFallback} on a live spec: the names go back
 * into `secretEnv` (+ `secretEnvFileFallback`), their `<NAME>_FILE` env and
 * the label drop — so the next deploy re-decides (the image may have a shell now).
 */
function unwrapSecretEnvFileFallback(spec: ServiceSpec): ServiceSpec {
  const names = secretEnvFileNames(spec.labels);
  if (names.length === 0) return spec;
  const labels = { ...(spec.labels ?? {}) };
  delete labels[SECRET_ENV_FILE_LABEL];
  const env = { ...(spec.env ?? {}) };
  for (const n of names) if (env[`${n}_FILE`] === `${SECRETS_DIR}/${n}`) delete env[`${n}_FILE`];
  const out: ServiceSpec = { ...spec, labels };
  if (Object.keys(env).length) out.env = env;
  else delete out.env;
  out.secretEnv = [...new Set([...(spec.secretEnv ?? []), ...names])];
  out.secretEnvFileFallback = [...new Set([...(spec.secretEnvFileFallback ?? []), ...names])];
  return out;
}

// ── controller planning: desired secret vars → spec patch ────────────────────

export interface SecretVarDesired {
  key: string;
  delivery: SecretDelivery;
  /** Physical Docker secret this key should mount (already created). */
  secretName: string;
}

type SecretRef = NonNullable<ServiceSpec['secrets']>[number];

/**
 * Apply a service's full desired secret-var set to a (live or fresh) spec.
 * PURE. `managed` = every physical app-secret name of THIS service (any key,
 * any version) — those refs are replaced wholesale; unrelated refs (managed
 * DB passwords, secret families, compose secrets) are untouched.
 *
 *  - each key mounts at `/run/secrets/<KEY>` (target = KEY, stable across rotations),
 *  - `env` keys join `secretEnv`; `file` keys get `<KEY>_FILE`,
 *  - a plain env var with the same KEY is removed (the value must not linger
 *    in the spec), as is a stale `_FILE` pointer of a key no longer file-mode.
 */
export function applySecretVars(
  base: ServiceSpec,
  desired: readonly SecretVarDesired[],
  managed: ReadonlySet<string>,
): ServiceSpec {
  const spec = unwrapSecretEnv(base);
  const keys = new Set(desired.map((d) => d.key));
  const previouslyManagedTargets = new Set(
    (spec.secrets ?? []).filter((r) => managed.has(r.source)).map((r) => r.target ?? r.source),
  );

  const refs: SecretRef[] = (spec.secrets ?? []).filter(
    (r) => !managed.has(r.source) && !keys.has(r.target ?? r.source),
  );
  for (const d of desired) refs.push({ source: d.secretName, target: d.key, mode: 0o444 });

  const env = { ...(spec.env ?? {}) };
  for (const t of previouslyManagedTargets) {
    if (env[`${t}_FILE`] === `${SECRETS_DIR}/${t}`) delete env[`${t}_FILE`];
  }
  const secretEnv = new Set((spec.secretEnv ?? []).filter((n) => !previouslyManagedTargets.has(n) && !keys.has(n)));
  for (const d of desired) {
    delete env[d.key];
    if (d.delivery === 'file') env[`${d.key}_FILE`] = `${SECRETS_DIR}/${d.key}`;
    else secretEnv.add(d.key);
  }

  const out: ServiceSpec = { ...spec };
  if (refs.length > 0) out.secrets = refs;
  else delete out.secrets;
  if (Object.keys(env).length > 0) out.env = env;
  else delete out.env;
  if (secretEnv.size > 0) out.secretEnv = [...secretEnv].sort();
  else delete out.secretEnv;
  return out;
}

/** How each mounted app secret of a live spec is delivered (read side). */
export function secretVarDelivery(
  env: Record<string, string> | undefined,
  secretEnv: readonly string[] | undefined,
  key: string,
): SecretDelivery {
  if (secretEnv?.includes(key)) return 'env';
  if (env?.[`${key}_FILE`] === `${SECRETS_DIR}/${key}`) return 'file';
  return 'env';
}

// ── GC: which old versions are safe to remove ────────────────────────────────

export interface GcServiceView {
  name: string;
  /** Physical secret names the live spec references. */
  secrets: readonly string[];
  /** Converged = no rolling update in flight (and not rolling back). */
  converged: boolean;
  /** Last spec change (ms) — a removal/rotation is only as old as this. */
  updatedAt: number;
  /** Health-gate window from `swarmy.deploy.safety` (seconds), if any. */
  gateWindowSec?: number | null;
}

/** Default wait after a spec change before an old version may go (≥ health-gate window). */
export const APP_SECRET_GC_GRACE_MS = 10 * 60_000;

/**
 * PURE — the app-secret versions the GC may remove now. A version goes only
 * when ALL hold:
 *  - no live service spec references it (Docker would refuse anyway),
 *  - it is not the version the service currently mounts,
 *  - its service is converged (an update in flight — or its rollback — may
 *    still need it),
 *  - the service's last spec change AND the version's own creation are older
 *    than the grace window (≥ the health gate's window + 60s), so an
 *    auto-rollback inside the window still finds the secret it points back at.
 * The version a service mounts is never removed. A key the service no longer
 * mounts (variable removed) loses every version once the removal is past the
 * grace window. A service that is gone keeps its newest version per key (so a
 * redeploy of the same name can reuse it) and loses the rest.
 */
export function appSecretsToPrune(
  versions: readonly AppSecretVersion[],
  services: readonly GcServiceView[],
  now: number,
  graceMs = APP_SECRET_GC_GRACE_MS,
): string[] {
  const referenced = new Set<string>();
  for (const s of services) for (const n of s.secrets) referenced.add(n);
  const byService = new Map(services.map((s) => [s.name, s]));

  const groups = new Map<string, AppSecretVersion[]>();
  for (const v of versions) {
    const k = `${v.service}\u0000${v.key}`;
    const list = groups.get(k) ?? [];
    list.push(v);
    groups.set(k, list);
  }

  const out: string[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => b.version - a.version);
    const svc = byService.get(sorted[0]!.service);
    const grace = Math.max(graceMs, ((svc?.gateWindowSec ?? 0) + 60) * 1000);
    const old = (v: AppSecretVersion) => now - v.createdAt >= grace;
    if (!svc) {
      for (const v of sorted.slice(1)) if (!referenced.has(v.name) && old(v)) out.push(v.name);
      continue;
    }
    if (!svc.converged || now - svc.updatedAt < grace) continue;
    for (const v of sorted) {
      if (referenced.has(v.name) || !old(v)) continue;
      out.push(v.name);
    }
  }
  return out.sort();
}

// ── compose redeploy carry ───────────────────────────────────────────────────

/** The physical app-secret name among `names` for (service, key), if any (newest). */
function liveAppSecretFor(service: string, key: string, names: readonly string[]): string | undefined {
  let best: { name: string; v: number } | undefined;
  for (const n of names) {
    const m = /_v(\d+)$/.exec(n);
    if (!m) continue;
    const v = Number(m[1]);
    if (appSecretName(service, key, v) !== n) continue;
    if (!best || v > best.v) best = { name: n, v };
  }
  return best?.name;
}

/**
 * PURE — carry the secret variables set on a LIVE service (dashboard/API)
 * across a compose (re)deploy, which rebuilds the spec from YAML that never
 * mentions them. Identity comes from the physical name convention
 * (`<service>_<KEY>_v<N>`) plus the live env plumbing (`SWARMY_SECRET_ENV`,
 * `<KEY>_FILE=/run/secrets/<KEY>`). The compose wins on conflict: a key it sets
 * itself (as `KEY`, `KEY_FILE` or a mount at `/run/secrets/KEY`) is left alone.
 */
export function carrySecretVars(
  spec: ServiceSpec,
  live: { name: string; env?: readonly string[]; secrets?: readonly string[] } | undefined,
): ServiceSpec {
  if (!live?.secrets?.length) return spec;
  const env: Record<string, string> = {};
  for (const kv of live.env ?? []) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const envKeys = (env[SECRET_ENV_VAR] ?? '').split(',').filter(isEnvName);
  const fileKeys = Object.entries(env)
    .map(([k, v]) => (/^([A-Za-z_][A-Za-z0-9_]*)_FILE$/.exec(k)?.[1] && v === `${SECRETS_DIR}/${k.slice(0, -5)}` ? k.slice(0, -5) : null))
    .filter((k): k is string => k !== null);

  const composeTargets = new Set((spec.secrets ?? []).map((r) => r.target ?? r.source));
  const taken = (k: string) =>
    composeTargets.has(k) || spec.env?.[k] !== undefined || spec.env?.[`${k}_FILE`] !== undefined || spec.secretEnv?.includes(k);

  const desired: SecretVarDesired[] = [];
  for (const [keys, delivery] of [[envKeys, 'env'], [fileKeys, 'file']] as const) {
    for (const key of keys) {
      if (taken(key) || desired.some((d) => d.key === key)) continue;
      const name = liveAppSecretFor(live.name, key, live.secrets);
      if (name) desired.push({ key, delivery, secretName: name });
    }
  }
  if (desired.length === 0) return spec;
  // `managed` is empty: the compose's own refs/secretEnv are kept as-is.
  return applySecretVars(spec, desired, new Set());
}
