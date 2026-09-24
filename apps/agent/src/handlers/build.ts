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
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { BuildImagePayload, BuildImageResult } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';
import { authForImage, pullWithFallback } from './pull-fallback';

const DEFAULT_BUILDER_IMAGE = 'moby/buildkit:rootless';
const CONTAINER_PREFIX = 'swarmy-build-';
/** How many trailing log lines a failed build's error message carries. */
const ERROR_TAIL_LINES = 15;
/** Bounded tail of combined output kept for digest parsing + error context. */
const MAX_TAIL_CHARS = 64 * 1024;

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
 */
export function renderBuildProgram(p: BuildImagePayload): string {
  const dockerfile = p.source.dockerfile ?? 'Dockerfile';
  const subdir = p.source.subdir ?? '.';
  const cloneUrl = authedGitUrl(p.source.url, p.source.token, p.source.tokenUser);
  const buildArgFlags = Object.entries(p.buildArgs ?? {})
    .map(([k, v]) => `--opt build-arg:${k}=${shq(v)}`)
    .join(' ');
  const push = p.pushPolicy === 'always';
  const primaryRef = p.imageRefs[0] ?? '';
  const outputs = p.imageRefs
    .map(
      (ref) =>
        `--output ${shq(`type=image,name=${ref},push=${push ? 'true' : 'false'},registry.insecure=true`)}`,
    )
    .join(' ');

  // Registry auth for the push, written to a one-shot docker config consumed by
  // buildctl, never persisted past the container's lifetime.
  // Extra `pullAuths` (private FROM bases) go in first; the push login wins on
  // a server collision.
  const dockerConfig = renderDockerConfig(p, primaryRef);
  const ctxDir = `"$W"/${shq(subdir)}`;

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
    'rootlesskit buildkitd --oci-worker-no-process-sandbox >/tmp/buildkitd.log 2>&1 &',
    'ready=0',
    'for i in $(seq 1 30); do buildctl debug workers >/dev/null 2>&1 && ready=1 && break; sleep 1; done',
    'if [ "$ready" != 1 ]; then echo "buildkitd did not become ready within 30s" >&2; cat /tmp/buildkitd.log >&2; exit 1; fi',
    [
      'buildctl build',
      '--frontend dockerfile.v0',
      `--local context=${ctxDir}`,
      `--local dockerfile=${ctxDir}`,
      `--opt filename=${shq(dockerfile)}`,
      p.target ? `--opt target=${shq(p.target)}` : '',
      p.platform ? `--opt platform=${shq(p.platform)}` : '',
      buildArgFlags,
      outputs,
      '--metadata-file /tmp/meta.json',
    ]
      .filter(Boolean)
      .join(' '),
    // Surface the digest on a parseable line for the agent to capture. BuildKit
    // pretty-prints meta.json (`"key": "value"`), so tolerate optional spaces.
    `echo "SWARMY_DIGEST=$(tr -d '\\n' < /tmp/meta.json | sed -n 's/.*"containerimage.digest": *"\\([^"]*\\)".*/\\1/p')"`,
  ].join('\n');
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
  await d.getContainer(name).remove({ force: true }).catch(() => undefined);

  // Secrets that must not sit in the program text (argv) ride the container env.
  const buildEnv: Record<string, string> = p.source.sshKey ? { SWARMY_SSH_KEY: p.source.sshKey } : {};
  const container = await d.createContainer(builderContainerOptions(name, image, renderBuildProgram(p), buildEnv));

  let seq = 0;
  let tail = '';
  const secrets = [p.source.token, p.registryAuth?.password, ...(p.pullAuths ?? []).map((a) => a.password)].filter(
    (x): x is string => Boolean(x),
  );
  if (p.source.sshKey) secrets.push(p.source.sshKey);
  const emit = (stream: 'stdout' | 'stderr', raw: string) => {
    // Never echo the git token / registry password into logs or error text.
    const text = redact(raw, secrets);
    tail = (tail + text).slice(-MAX_TAIL_CHARS);
    conn.send('logChunk', { commandId: p.commandId, stream, seq: seq++, data: text, eof: false });
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
    conn.send('logChunk', { commandId: p.commandId, stream: 'stdout', seq: seq++, data: '', eof: true });

    const code = (result as { StatusCode?: number }).StatusCode ?? 0;
    if (code !== 0) throw new Error(withTail(`build exited ${code}`, tail));
    const digest = parseBuildDigest(tail);
    if (!digest) throw new Error(withTail('build finished but no image digest was produced', tail));

    return {
      imageRef: primaryRef,
      imageRefs: p.imageRefs,
      digest,
    };
  } finally {
    await d.getContainer(name).remove({ force: true }).catch(() => undefined);
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
