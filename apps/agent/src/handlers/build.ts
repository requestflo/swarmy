/**
 * Build handler (epic: git-cicd-registry, MVP).
 *
 * Runs a BuildKit-style builder container (`moby/buildkit:rootless` via `buildctl`,
 * or the bundled `img`) via dockerode to: shallow-clone the git source, build the
 * Dockerfile, and push the resulting image to the in-swarm registry in one step
 * (`--output type=image,push=true,registry.insecure=true`), then parse the pushed
 * digest. The builder runs on the HOST network so it pushes to the routing-mesh
 * registry at `localhost:5000` — the same address every node's dockerd pulls.
 *
 * Mirrors `applyMesh`/`joinNetbird` in the executor: it consumes a resolved
 * payload and applies it on the node, streaming build output as `logChunk`s
 * through the existing `conn.send('logChunk', …)` path (same machinery as
 * `streamLogs`). It never reasons about which registry/provider it is.
 *
 * Gated: builds only run on a node with the Builder role (`swarmy.node.builder`,
 * asserted by the controller as `builderCapable`) unless `SWARMY_ALLOW_BUILD`
 * explicitly overrides (see executor case + `buildGateAllows`), otherwise the
 * command is rejected with `E_BUILD_DISABLED`. The git token
 * and registry password arrive over the authenticated WS and are passed as build
 * secrets / a one-shot Docker auth config — never written into an image layer.
 *
 * Zero-config builds (Railpack): with `builder: 'railpack'` (or `'auto'` and no
 * Dockerfile in the context) the SAME rootless BuildKit runs Railpack's
 * documented platform flow — `railpack prepare` (run inside BuildKit with the
 * CLI taken from the pinned frontend image, so plan and frontend are one
 * version) → a BuildKit plan, rewrite the plan's base images to digest-pinned
 * (or mirrored) refs, then `buildctl build --frontend gateway.v0
 * --opt source=<frontend>`.
 * Build-time env values ride the container env and reach Railpack's steps as
 * BuildKit secrets. `cache` adds `--import-cache/--export-cache type=registry`
 * against the in-swarm registry (a missing cache is a cold build; a failed
 * export never fails the build).
 */
import type { DockerClient } from '@swarmy/core/docker';
import type {
  BuildImagePayload,
  BuildImageResult,
  RailpackBuildInfo,
  RailpackBuildOptions,
} from '@swarmy/core/protocol';
import { pinnedSystemRef, railpackImageRewrites } from '@swarmy/core/system-images';
import type { AgentConnection } from '../connection';
import { authForImage, pullWithFallback } from './pull-fallback';

const DEFAULT_BUILDER_IMAGE = 'moby/buildkit:rootless';
const CONTAINER_PREFIX = 'swarmy-build-';
/** How many trailing log lines a failed build's error message carries. */
const ERROR_TAIL_LINES = 15;
/** Bounded tail of combined output kept for digest parsing + error context. */
const MAX_TAIL_CHARS = 64 * 1024;

/** Railpack's default plan file name (the frontend reads it from the `dockerfile` local). */
export const RAILPACK_PLAN_FILE = 'railpack-plan.json';
/** Program lines carrying structured build facts; captured by the agent, never shown in the log. */
export const META_PREFIX = 'SWARMY_META ';

/** Resolve the auth header git fetch uses, without baking it into a layer. */
function authedGitUrl(url: string, token?: string, user = 'x-access-token'): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    // x-access-token works for GitHub PATs/App tokens; GitLab wants oauth2:<token>.
    u.username = user;
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * The one-shot docker config.json consumed by buildctl: `pullAuths` (org
 * third-party logins for private `FROM` bases) plus the push `registryAuth`,
 * keyed by server. Empty string when there is nothing to authenticate.
 */
export function renderDockerConfig(p: BuildImagePayload, primaryRef: string): string {
  const auths: Record<string, { auth: string }> = {};
  const put = (a: { username: string; password: string; server?: string }, fallback: string) => {
    const server = a.server ?? fallback;
    if (!server) return;
    auths[server] = { auth: Buffer.from(`${a.username}:${a.password}`).toString('base64') };
  };
  for (const a of p.pullAuths ?? []) put(a, '');
  if (p.registryAuth) put(p.registryAuth, primaryRef.split('/')[0] ?? '');
  return Object.keys(auths).length ? JSON.stringify({ auths }) : '';
}

/** Registry host of an image ref (`localhost:5000/x:y` → `localhost:5000`), or null for Hub shorthands. */
function refHost(ref: string): string | null {
  const first = ref.split('/')[0] ?? '';
  return ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : null;
}

/**
 * buildkitd config: the in-swarm registry (every push/cache host) is plain
 * HTTP, so buildkitd itself must know that to pull the mirrored frontend/base
 * images and import/export the registry cache (the image output already sets
 * `registry.insecure=true` per push).
 */
export function renderBuildkitdToml(p: BuildImagePayload): string {
  const hosts = new Set<string>();
  for (const r of [...p.imageRefs, ...(p.cache?.importRefs ?? []), ...(p.cache?.exportRef ? [p.cache.exportRef] : [])]) {
    const h = refHost(r);
    if (h) hosts.add(h);
  }
  return [...hosts]
    .sort()
    .map((h) => `[registry."${h}"]\n  http = true\n  insecure = true`)
    .join('\n');
}

/**
 * The env `railpack prepare` receives, in order: Railpack config first, then
 * the build-time env (sorted). Railpack lists every one of these as a build
 * secret in the plan, so each is ALSO passed to buildctl as `--secret`.
 */
export function railpackEnvEntries(r: RailpackBuildOptions | undefined): Array<[string, string]> {
  if (!r) return [];
  const out: Array<[string, string]> = [];
  if (r.installCmd) out.push(['RAILPACK_INSTALL_CMD', r.installCmd]);
  if (r.packages?.length) out.push(['RAILPACK_PACKAGES', r.packages.join(' ')]);
  // `...` keeps the provider's own apt packages (ours are added, not a replacement).
  if (r.buildAptPackages?.length) out.push(['RAILPACK_BUILD_APT_PACKAGES', ['...', ...r.buildAptPackages].join(' ')]);
  if (r.deployAptPackages?.length) out.push(['RAILPACK_DEPLOY_APT_PACKAGES', ['...', ...r.deployAptPackages].join(' ')]);
  const taken = new Set(out.map(([k]) => k));
  for (const [k, v] of Object.entries(r.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!taken.has(k)) out.push([k, v]);
  }
  return out;
}

/** Container env var carrying the i-th Railpack env value (the program only ever names it). */
export const railpackEnvVar = (i: number): string => `SWARMY_BENV_${i}`;

/** Env for the builder container: the deploy key and the Railpack env values (never argv). */
export function builderEnv(p: BuildImagePayload): Record<string, string> {
  const env: Record<string, string> = p.source.sshKey ? { SWARMY_SSH_KEY: p.source.sshKey } : {};
  if (p.builder === 'railpack' || p.builder === 'auto') {
    railpackEnvEntries(p.railpack).forEach(([, v], i) => (env[railpackEnvVar(i)] = v));
  }
  return env;
}

/** The frontend image a Railpack build uses (payload override, else the pinned BOM ref). */
export function railpackFrontend(p: BuildImagePayload): string {
  return p.railpack?.frontendImage ?? pinnedSystemRef('railpackFrontend');
}

/** `sed` BRE-escape a literal pattern (the plan rewrite matches exact quoted refs; `#` is the delimiter). */
function sedPattern(s: string): string {
  return s.replace(/[.[\]*^$\\#]/g, (c) => `\\${c}`);
}

/** `sed` replacement-escape a literal (`\`, `&`, and the `#` delimiter). */
function sedReplacement(s: string): string {
  return s.replace(/[\\&#]/g, (c) => `\\${c}`);
}

function cacheFlags(p: BuildImagePayload): string[] {
  const c = p.cache;
  if (!c) return [];
  return [
    ...(c.importRefs ?? []).map((r) => `--import-cache ${shq(`type=registry,ref=${r}`)}`),
    ...(c.exportRef
      ? [`--export-cache ${shq(`type=registry,ref=${c.exportRef},mode=${c.mode ?? 'max'},ignore-error=true`)}`]
      : []),
  ];
}

function outputFlags(p: BuildImagePayload): string {
  const push = p.pushPolicy === 'always';
  return p.imageRefs
    .map(
      (ref) =>
        `--output ${shq(`type=image,name=${ref},push=${push ? 'true' : 'false'},registry.insecure=true`)}`,
    )
    .join(' ');
}

function dockerfileBuildLine(p: BuildImagePayload, ctxDir: string): string {
  const dockerfile = p.source.dockerfile ?? 'Dockerfile';
  const buildArgFlags = Object.entries(p.buildArgs ?? {})
    .map(([k, v]) => `--opt build-arg:${k}=${shq(v)}`)
    .join(' ');
  return [
    'buildctl build',
    '--frontend dockerfile.v0',
    `--local context=${ctxDir}`,
    `--local dockerfile=${ctxDir}`,
    `--opt filename=${shq(dockerfile)}`,
    p.target ? `--opt target=${shq(p.target)}` : '',
    p.platform ? `--opt platform=${shq(p.platform)}` : '',
    buildArgFlags,
    ...cacheFlags(p),
    outputFlags(p),
    '--metadata-file /tmp/meta.json',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Image `railpack prepare` runs in: alpine + bash (mise needs bash; the BuildKit image is busybox-only). */
export function railpackPrepareImage(p: BuildImagePayload): string {
  return p.railpack?.prepareImage ?? pinnedSystemRef('railpackPrepare');
}

/**
 * The script `railpack prepare` runs as, inside BuildKit (pure). Build-env
 * values are read from BuildKit secret files, never argv of the program text.
 * Railpack's documented transient exit (75) is retried; the exit code is
 * written next to the plan so a failed plan still returns its info/logs.
 */
export function renderRailpackPrepareScript(p: BuildImagePayload): string {
  const r = p.railpack ?? {};
  const env = railpackEnvEntries(p.railpack);
  const prepare = [
    'railpack prepare /app',
    `--plan-out /out/${RAILPACK_PLAN_FILE}`,
    '--info-out /out/info.json',
    r.buildCmd ? `--build-cmd ${shq(r.buildCmd)}` : '',
    r.startCmd ? `--start-cmd ${shq(r.startCmd)}` : '',
    ...env.map(([k], i) => `--env "${k}=$(cat /run/secrets/${railpackEnvVar(i)})"`),
  ]
    .filter(Boolean)
    .join(' ');
  return [
    'set -u',
    'mkdir -p /out',
    'n=0',
    `while :; do rc=0; ${prepare} >>/out/prepare.log 2>&1 || rc=$?; if [ "$rc" = 75 ] && [ "$n" -lt 3 ]; then n=$((n+1)); echo "railpack prepare hit a transient error, retrying ($n/3)" >>/out/prepare.log; sleep 3; continue; fi; break; done`,
    'echo "$rc" > /out/rc',
  ].join('\n');
}

/** The Dockerfile that runs `prepare` in BuildKit and exports only `/out` (pure). */
export function renderRailpackPrepareDockerfile(p: BuildImagePayload): string {
  const env = railpackEnvEntries(p.railpack);
  const mounts = [
    '--mount=type=bind,from=app,target=/app',
    ...env.map((_, i) => `--mount=type=secret,id=${railpackEnvVar(i)}`),
  ].join(' ');
  return [
    `FROM ${railpackFrontend(p)} AS rp`,
    `FROM ${railpackPrepareImage(p)} AS prep`,
    'COPY --from=rp /railpack /usr/local/bin/railpack',
    'COPY prepare.sh /swarmy-prepare.sh',
    `RUN ${mounts} sh /swarmy-prepare.sh`,
    'FROM scratch',
    'COPY --from=prep /out /',
  ].join('\n');
}

/** `printf` a multi-line text into a file, one quoted argument per line. */
function writeFileLine(text: string, file: string): string {
  return `printf '%s\\n' ${text.split('\n').map(shq).join(' ')} > ${file}`;
}

/**
 * The Railpack half of the program (pure, golden-tested), Railpack's
 * documented platform flow on the existing rootless BuildKit:
 *
 *  1. `railpack prepare` — run INSIDE BuildKit (dockerfile frontend) on a
 *     small bash image with the CLI copied out of the pinned frontend image,
 *     so plan and frontend are one version and mise gets the bash it needs
 *     (the BuildKit image is busybox). The source is a read-only named
 *     context; only `/out` (plan, info, log, exit code) comes back.
 *  2. Pin the plan's base images (tag → digest / mirrored copy).
 *  3. `buildctl build --frontend gateway.v0 --opt source=<frontend>` with the
 *     registry cache, build env as `--secret`s + `secrets-hash`.
 */
export function renderRailpackSteps(p: BuildImagePayload, ctxDir: string): string[] {
  const r = p.railpack ?? {};
  const frontend = railpackFrontend(p);
  const env = railpackEnvEntries(p.railpack);
  const rewrites = Object.entries(r.imageRewrites ?? railpackImageRewrites()).filter(([from, to]) => from !== to);
  const plan = `"$RP/plan/${RAILPACK_PLAN_FILE}"`;
  const envSecrets = env.map((_, i) => `--secret id=${railpackEnvVar(i)},env=${railpackEnvVar(i)}`);
  const prep = [
    'buildctl build',
    '--frontend dockerfile.v0',
    '--local context="$RP/prep"',
    '--local dockerfile="$RP/prep"',
    `--local app=${ctxDir}`,
    '--opt context:app=local:app',
    ...envSecrets,
    p.platform ? `--opt platform=${shq(p.platform)}` : '',
    '--output type=local,dest="$RP/out"',
  ]
    .filter(Boolean)
    .join(' ');
  const secretsHash = env.length
    ? `SH=$( { ${env.map(([k], i) => `printf '%s=%s\\n' ${shq(k)} "$${railpackEnvVar(i)}";`).join(' ')} } | sha256sum | cut -d' ' -f1)`
    : '';
  const build = [
    'buildctl build',
    '--frontend gateway.v0',
    `--opt source=${shq(frontend)}`,
    `--local context=${ctxDir}`,
    '--local dockerfile="$RP/plan"',
    r.cacheKey ? `--opt build-arg:cache-key=${shq(r.cacheKey)}` : '',
    env.length ? '--opt build-arg:secrets-hash="$SH"' : '',
    ...env.map(([k], i) => `--secret id=${k},env=${railpackEnvVar(i)}`),
    p.platform ? `--opt platform=${shq(p.platform)}` : '',
    ...cacheFlags(p),
    outputFlags(p),
    '--metadata-file /tmp/meta.json',
  ]
    .filter(Boolean)
    .join(' ');
  return [
    'RP="$HOME/railpack"',
    'rm -rf "$RP" && mkdir -p "$RP/prep" "$RP/out" "$RP/plan"',
    // A fresh clone's .git differs byte-wise every time (index stat data), and
    // Railpack copies the whole context: drop it so warm builds hit the cache.
    'rm -rf "$W/.git"',
    writeFileLine(renderRailpackPrepareDockerfile(p), '"$RP/prep/Dockerfile"'),
    writeFileLine(renderRailpackPrepareScript(p), '"$RP/prep/prepare.sh"'),
    'echo "Railpack: planning the build (railpack prepare)"',
    `if ! ${prep} >"$RP/prep.log" 2>&1; then cat "$RP/prep.log" >&2; echo "could not run railpack prepare in BuildKit" >&2; exit 1; fi`,
    'cat "$RP/out/prepare.log" 2>/dev/null || true',
    'rc=$(cat "$RP/out/rc" 2>/dev/null || echo 1)',
    `if [ -f "$RP/out/info.json" ]; then echo "${META_PREFIX}railpack-info $(base64 < "$RP/out/info.json" | tr -d '\\n')"; fi`,
    `if [ "$rc" != 0 ]; then echo "Railpack could not plan this app (railpack prepare exited $rc). Add a Dockerfile, or set build.start in swarmy.yaml." >&2; exit 1; fi`,
    `mv "$RP/out/${RAILPACK_PLAN_FILE}" ${plan}`,
    ...(rewrites.length
      ? [`sed -i ${rewrites.map(([from, to]) => `-e ${shq(`s#"${sedPattern(from)}"#"${sedReplacement(to)}"#g`)}`).join(' ')} ${plan}`]
      : []),
    `echo "${META_PREFIX}railpack-plan $(base64 < ${plan} | tr -d '\\n')"`,
    ...(secretsHash ? [secretsHash] : []),
    build,
  ];
}

/**
 * Render the shell program the builder container runs (pure, golden-tested).
 *
 * `moby/buildkit:rootless` runs as uid 1000, so everything writable lives
 * under `$HOME` (the workspace and the one-shot `DOCKER_CONFIG`, exported so
 * buildctl/buildkitd read the push auth). buildkitd must be started through
 * `rootlesskit`, and we poll `buildctl debug workers` for readiness instead of
 * a fixed sleep. The in-swarm registry is plain HTTP, so the push sets
 * `registry.insecure=true`. The digest is extracted from BuildKit's metadata
 * file with a whitespace-tolerant pattern (`"containerimage.digest": "…"`).
 *
 * `builder` absent renders the original Dockerfile program byte-for-byte
 * (older controllers); `dockerfile` / `railpack` / `auto` add the buildkitd
 * registry config, the builder marker and (for `auto`) the Dockerfile probe.
 */
export function renderBuildProgram(p: BuildImagePayload): string {
  const subdir = p.source.subdir ?? '.';
  const cloneUrl = authedGitUrl(p.source.url, p.source.token, p.source.tokenUser);
  const primaryRef = p.imageRefs[0] ?? '';

  // Registry auth for the push, written to a one-shot docker config consumed by
  // buildctl, never persisted past the container's lifetime.
  // Extra `pullAuths` (private FROM bases) go in first; the push login wins on
  // a server collision.
  const dockerConfig = renderDockerConfig(p, primaryRef);
  const ctxDir = `"$W"/${shq(subdir)}`;
  const toml = p.builder ? renderBuildkitdToml(p) : '';

  const buildLines: string[] = (() => {
    const dockerfileLine = dockerfileBuildLine(p, ctxDir);
    switch (p.builder) {
      case undefined:
        return [dockerfileLine];
      case 'dockerfile':
        return [`echo "${META_PREFIX}builder dockerfile"`, dockerfileLine];
      case 'railpack':
        return [`echo "${META_PREFIX}builder railpack"`, ...renderRailpackSteps(p, ctxDir)];
      case 'auto': {
        const df = p.source.dockerfile ?? 'Dockerfile';
        return [
          `if [ -f ${ctxDir}/${shq(df)} ]; then B=dockerfile; else B=railpack; echo ${shq(`No ${df} in ${subdir === '.' ? 'the repo root' : subdir}, so building with Railpack (zero-config)`)}; fi`,
          `echo "${META_PREFIX}builder $B"`,
          'if [ "$B" = dockerfile ]; then',
          dockerfileLine,
          'else',
          ...renderRailpackSteps(p, ctxDir),
          'fi',
        ];
      }
    }
  })();

  return [
    'set -e',
    'W="$HOME/workspace"',
    'export DOCKER_CONFIG="$HOME/.docker"',
    'rm -rf "$W" && mkdir -p "$W"',
    // Deploy key (ssh URLs): from the container env, written under $HOME only.
    ...(p.source.sshKey
      ? [
          'mkdir -p "$HOME/.ssh" && printf \'%s\\n\' "$SWARMY_SSH_KEY" > "$HOME/.ssh/id" && chmod 600 "$HOME/.ssh/id" && export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts"',
        ]
      : []),
    // Exact sha (git-apps): fetch that commit, never "whatever the branch is now".
    p.source.sha
      ? `git -C "$W" init -q && git -C "$W" remote add origin ${shq(cloneUrl)} && git -C "$W" fetch -q --depth 1 origin ${shq(p.source.sha)} && git -C "$W" checkout -q FETCH_HEAD`
      : `git clone --depth 1 --branch ${shq(p.source.ref)} ${shq(cloneUrl)} "$W"`,
    dockerConfig
      ? `mkdir -p "$DOCKER_CONFIG" && printf %s ${shq(dockerConfig)} > "$DOCKER_CONFIG/config.json"`
      : ':',
    ...(toml
      ? [
          `mkdir -p "$HOME/.config/buildkit" && printf '%s\\n' ${shq(toml)} > "$HOME/.config/buildkit/buildkitd.toml"`,
          'rootlesskit buildkitd --config "$HOME/.config/buildkit/buildkitd.toml" --oci-worker-no-process-sandbox >/tmp/buildkitd.log 2>&1 &',
        ]
      : ['rootlesskit buildkitd --oci-worker-no-process-sandbox >/tmp/buildkitd.log 2>&1 &']),
    'ready=0',
    'for i in $(seq 1 30); do buildctl debug workers >/dev/null 2>&1 && ready=1 && break; sleep 1; done',
    'if [ "$ready" != 1 ]; then echo "buildkitd did not become ready within 30s" >&2; cat /tmp/buildkitd.log >&2; exit 1; fi',
    ...buildLines,
    // Surface the digest on a parseable line for the agent to capture. BuildKit
    // pretty-prints meta.json (`"key": "value"`), so tolerate optional spaces.
    `echo "SWARMY_DIGEST=$(tr -d '\\n' < /tmp/meta.json | sed -n 's/.*"containerimage.digest": *"\\([^"]*\\)".*/\\1/p')"`,
  ].join('\n');
}

/**
 * Split streamed output into log text and captured `SWARMY_META` lines (pure).
 * Only complete lines are classified; a partial trailing line is carried to
 * the next chunk (and flushed as log text at the end).
 */
export function splitMetaLines(
  carry: string,
  chunk: string,
): { forward: string; metas: string[]; carry: string } {
  const text = carry + chunk;
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { forward: '', metas: [], carry: text };
  const complete = text.slice(0, lastNl + 1);
  const rest = text.slice(lastNl + 1);
  const metas: string[] = [];
  const kept: string[] = [];
  for (const line of complete.split('\n').slice(0, -1)) {
    if (line.startsWith(META_PREFIX)) metas.push(line.slice(META_PREFIX.length).trimEnd());
    else kept.push(line);
  }
  return { forward: kept.length ? `${kept.join('\n')}\n` : '', metas, carry: rest };
}

/** Decode the captured meta lines into the result's builder facts (pure). */
export function parseBuildMeta(metas: string[]): {
  builder?: 'dockerfile' | 'railpack';
  railpack?: RailpackBuildInfo;
} {
  let builder: 'dockerfile' | 'railpack' | undefined;
  let info: Record<string, unknown> | undefined;
  let plan: Record<string, unknown> | undefined;
  const json = (b64: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  for (const m of metas) {
    const sp = m.indexOf(' ');
    const kind = sp < 0 ? m : m.slice(0, sp);
    const value = sp < 0 ? '' : m.slice(sp + 1).trim();
    if (kind === 'builder' && (value === 'dockerfile' || value === 'railpack')) builder = value;
    else if (kind === 'railpack-info') info = json(value);
    else if (kind === 'railpack-plan') plan = json(value);
  }
  if (!info && !plan) return builder ? { builder } : {};
  const packages: Record<string, string> = {};
  const resolved = (info?.resolvedPackages ?? {}) as Record<string, { resolvedVersion?: unknown }>;
  for (const [k, v] of Object.entries(resolved)) {
    if (typeof v?.resolvedVersion === 'string') packages[k] = v.resolvedVersion;
  }
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries((info?.metadata ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') metadata[k] = v;
  }
  const providers = Array.isArray(info?.detectedProviders)
    ? (info.detectedProviders as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const deploy = (plan?.deploy ?? {}) as { startCommand?: unknown };
  return {
    builder: builder ?? 'railpack',
    railpack: {
      ...(typeof info?.railpackVersion === 'string' ? { version: info.railpackVersion } : {}),
      providers,
      packages,
      metadata,
      ...(typeof deploy.startCommand === 'string' && deploy.startCommand ? { startCommand: deploy.startCommand } : {}),
    },
  };
}

/**
 * Count BuildKit plain-progress steps served from cache (`#12 CACHED`),
 * ignoring base-image resolves (`#2 docker-image://…`), which say nothing
 * about the build cache. Stateful across chunks (step names and their CACHED
 * line can arrive in different chunks).
 */
export function cachedStepCounter(): { feed(text: string): void; readonly count: number } {
  const names = new Map<string, string>();
  const counted = new Set<string>();
  return {
    feed(text: string) {
      for (const line of text.split('\n')) {
        const m = /^#(\d+) (.*?)\s*$/.exec(line);
        if (!m) continue;
        const [, id, rest] = m as unknown as [string, string, string];
        if (!names.has(id)) names.set(id, rest);
        if (rest === 'CACHED' && !(names.get(id) ?? '').startsWith('docker-image://')) counted.add(id);
      }
    },
    get count() {
      return counted.size;
    },
  };
}

/** One-shot convenience over {@link cachedStepCounter}. */
export function countCachedSteps(output: string): number {
  const c = cachedStepCounter();
  c.feed(output);
  return c.count;
}

/**
 * Extract the pushed digest from the builder's output. Prefers the explicit
 * `SWARMY_DIGEST=` marker; falls back to a raw BuildKit metadata blob
 * (`"containerimage.digest": "sha256:…"`, any whitespace around the colon).
 */
export function parseBuildDigest(output: string): string | null {
  const marker = [...output.matchAll(/SWARMY_DIGEST=(sha256:[a-f0-9]{64})/g)].pop();
  if (marker?.[1]) return marker[1];
  const meta = output.match(/"containerimage\.digest"\s*:\s*"(sha256:[a-f0-9]{64})"/);
  return meta?.[1] ?? null;
}

/** Last `n` non-empty lines of output, for a failed build's error message. */
export function tailLines(output: string, n = ERROR_TAIL_LINES): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-n);
}

/**
 * dockerode `createContainer` options for the builder (pure, unit-tested).
 * Host networking so buildctl reaches the registry at `localhost:5000` via the
 * swarm routing mesh — exactly the address every node's dockerd pulls from.
 */
export function builderContainerOptions(
  name: string,
  image: string,
  program: string,
  env: Record<string, string> = {},
) {
  return {
    name,
    Image: image,
    ...(Object.keys(env).length ? { Env: Object.entries(env).map(([k, v]) => `${k}=${v}`) } : {}),
    // Override the image ENTRYPOINT (`rootlesskit buildkitd`): the program starts
    // its own rootlesskit, and a nested one is refused a user namespace.
    Entrypoint: ['sh', '-c'],
    Cmd: [program],
    Tty: false,
    HostConfig: {
      NetworkMode: 'host',
      // Rootless BuildKit needs these to set up its user namespaces.
      Privileged: false,
      SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined'],
      AutoRemove: false,
    },
  };
}

/**
 * Build + push an image, streaming logs. The actual build runs inside a builder
 * container which has the BuildKit toolchain; we drive it with a shell program
 * that clones, builds, and pushes, emitting the final digest on stdout.
 */
export async function buildImage(
  docker: DockerClient,
  conn: AgentConnection,
  p: BuildImagePayload,
): Promise<BuildImageResult> {
  const d = docker.docker;
  const name = `${CONTAINER_PREFIX}${p.commandId.slice(0, 8)}`;
  const primaryRef = p.imageRefs[0] ?? '';

  // The controller may point `builderImage` at the mirrored BuildKit copy in the
  // in-swarm registry (pulled with the push login); upstream is the fallback.
  const image = p.builderImage
    ? await pullWithFallback(docker, p.builderImage, DEFAULT_BUILDER_IMAGE, authForImage(p.builderImage, p.registryAuth))
    : await docker
        .pullImage(DEFAULT_BUILDER_IMAGE)
        .catch(() => undefined)
        .then(() => DEFAULT_BUILDER_IMAGE);
  await d.getContainer(name).remove({ force: true, v: true }).catch(() => undefined);

  // Secrets that must not sit in the program text (argv) ride the container env.
  const buildEnv = builderEnv(p);
  const container = await d.createContainer(builderContainerOptions(name, image, renderBuildProgram(p), buildEnv));

  let seq = 0;
  let tail = '';
  const secrets = [p.source.token, p.registryAuth?.password, ...(p.pullAuths ?? []).map((a) => a.password)].filter(
    (x): x is string => Boolean(x),
  );
  if (p.source.sshKey) secrets.push(p.source.sshKey);
  // Build-time env values are Railpack build secrets: keep them out of the log
  // too (short values like "1"/"true" would only garble it).
  for (const v of Object.values(p.railpack?.env ?? {})) if (v.length >= 6) secrets.push(v);
  const metas: string[] = [];
  const carry: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  const cached = cachedStepCounter();
  const send = (stream: 'stdout' | 'stderr', text: string) => {
    if (!text) return;
    tail = (tail + text).slice(-MAX_TAIL_CHARS);
    cached.feed(text);
    conn.send('logChunk', { commandId: p.commandId, stream, seq: seq++, data: text, eof: false });
  };
  const emit = (stream: 'stdout' | 'stderr', raw: string) => {
    // Never echo the git token / registry password into logs or error text.
    // `SWARMY_META` lines (builder facts, Railpack info/plan) are captured, not logged.
    const split = splitMetaLines(carry[stream], redact(raw, secrets));
    carry[stream] = split.carry;
    metas.push(...split.metas);
    send(stream, split.forward);
  };
  try {
    const stream = (await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    })) as unknown as NodeJS.ReadableStream;
    const ended = new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
      stream.on('error', () => resolve());
    });
    // Non-TTY attach is multiplexed; demux so frame headers never reach the log.
    const sink = (s: 'stdout' | 'stderr') =>
      ({ write: (b: Buffer) => (emit(s, b.toString('utf8')), true) }) as unknown as NodeJS.WritableStream;
    (d.modem as unknown as {
      demuxStream(s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream): void;
    }).demuxStream(stream, sink('stdout'), sink('stderr'));

    await container.start();
    const result = await container.wait();
    // Let the attach stream drain so the final lines (incl. the digest) land.
    await Promise.race([ended, new Promise((r) => setTimeout(r, 2_000))]);
    for (const k of ['stdout', 'stderr'] as const) {
      const rest = carry[k];
      carry[k] = '';
      if (rest.startsWith(META_PREFIX)) metas.push(rest.slice(META_PREFIX.length).trimEnd());
      else send(k, rest);
    }
    conn.send('logChunk', { commandId: p.commandId, stream: 'stdout', seq: seq++, data: '', eof: true });

    const code = (result as { StatusCode?: number }).StatusCode ?? 0;
    if (code !== 0) throw new Error(withTail(`build exited ${code}`, tail));
    const digest = parseBuildDigest(tail);
    if (!digest) throw new Error(withTail('build finished but no image digest was produced', tail));

    const meta = parseBuildMeta(metas);
    const cachedSteps = cached.count;
    return {
      imageRef: primaryRef,
      imageRefs: p.imageRefs,
      digest,
      ...(cachedSteps ? { cacheHit: true, cachedSteps } : {}),
      ...meta,
    };
  } finally {
    // `v: true`: the BuildKit image declares a VOLUME for its state, so a
    // plain remove leaked GBs of anonymous volume per build on builder nodes.
    await d.getContainer(name).remove({ force: true, v: true }).catch(() => undefined);
  }
}

/** Replace every occurrence of each secret with `***`. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}

function withTail(message: string, output: string): string {
  const lines = tailLines(output);
  return lines.length ? `${message}\n${lines.join('\n')}` : message;
}

/** Minimal single-quote shell escaping for values interpolated into the program. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
