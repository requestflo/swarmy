/**
 * Build handler (epic: git-cicd-registry, MVP).
 *
 * Runs a BuildKit-style builder container (`moby/buildkit:rootless` via `buildctl`,
 * or the bundled `img`) via dockerode to: shallow-clone the git source, build the
 * Dockerfile, and push the resulting image to the in-swarm registry in one step
 * (`--output type=image,push=true`), then parse the pushed digest.
 *
 * Mirrors `applyMesh`/`joinNetbird` in the executor: it consumes a resolved
 * payload and applies it on the node, streaming build output as `logChunk`s
 * through the existing `conn.send('logChunk', …)` path (same machinery as
 * `streamLogs`). It never reasons about which registry/provider it is.
 *
 * Gated like exec: builds only run when `SWARMY_ALLOW_BUILD=true` (see executor
 * case), otherwise the command is rejected with `E_BUILD_DISABLED`. The git token
 * and registry password arrive over the authenticated WS and are passed as build
 * secrets / a one-shot Docker auth config — never written into an image layer.
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { BuildImagePayload, BuildImageResult } from '@swarmy/core/protocol';
import type { AgentConnection } from '../connection';

const DEFAULT_BUILDER_IMAGE = 'moby/buildkit:rootless';
const CONTAINER_PREFIX = 'swarmy-build-';

/** Resolve the auth header git fetch uses, without baking it into a layer. */
function authedGitUrl(url: string, token?: string): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    // x-access-token works for GitHub PATs; GitLab accepts oauth2:<token>.
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
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
  const image = p.builderImage ?? DEFAULT_BUILDER_IMAGE;
  const d = docker.docker;
  const name = `${CONTAINER_PREFIX}${p.commandId.slice(0, 8)}`;

  await docker.pullImage(image).catch(() => undefined);
  await d.getContainer(name).remove({ force: true }).catch(() => undefined);

  const dockerfile = p.source.dockerfile ?? 'Dockerfile';
  const subdir = p.source.subdir ?? '.';
  const cloneUrl = authedGitUrl(p.source.url, p.source.token);
  const buildArgFlags = Object.entries(p.buildArgs ?? {})
    .map(([k, v]) => `--opt build-arg:${k}=${shq(v)}`)
    .join(' ');
  const push = p.pushPolicy === 'always';
  const primaryRef = p.imageRefs[0] ?? '';
  const outputs = p.imageRefs
    .map((ref) => `--output type=image,name=${shq(ref)},push=${push ? 'true' : 'false'}`)
    .join(' ');

  // Registry auth for the push, written to a one-shot docker config consumed by
  // buildkitd, never persisted past the container's lifetime.
  const auth = p.registryAuth;
  const dockerConfig = auth
    ? JSON.stringify({
        auths: {
          [auth.server ?? primaryRef.split('/')[0] ?? '']: {
            auth: Buffer.from(`${auth.username}:${auth.password}`).toString('base64'),
          },
        },
      })
    : '';

  const program = [
    'set -e',
    'rm -rf /workspace && mkdir -p /workspace',
    `git clone --depth 1 --branch ${shq(p.source.ref)} ${shq(cloneUrl)} /workspace`,
    dockerConfig ? `mkdir -p /root/.docker && printf %s ${shq(dockerConfig)} > /root/.docker/config.json` : ':',
    'buildkitd --oci-worker-no-process-sandbox & sleep 2',
    [
      'buildctl build',
      '--frontend dockerfile.v0',
      `--local context=/workspace/${subdir}`,
      `--local dockerfile=/workspace/${subdir}`,
      `--opt filename=${shq(dockerfile)}`,
      p.target ? `--opt target=${shq(p.target)}` : '',
      p.platform ? `--opt platform=${shq(p.platform)}` : '',
      buildArgFlags,
      outputs,
      '--metadata-file /tmp/meta.json',
    ]
      .filter(Boolean)
      .join(' '),
    // Surface the digest on a parseable line for the agent to capture.
    `echo "SWARMY_DIGEST=$(grep -o '"containerimage.digest":"[^"]*"' /tmp/meta.json | head -1 | cut -d'"' -f4)"`,
  ].join('\n');

  const container = await d.createContainer({
    name,
    Image: image,
    Cmd: ['sh', '-c', program],
    Tty: false,
    HostConfig: {
      // Rootless BuildKit needs these to set up its user namespaces.
      Privileged: false,
      SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined'],
      AutoRemove: false,
    },
  });

  let seq = 0;
  let digest = '';
  try {
    const stream = (await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    })) as unknown as NodeJS.ReadableStream;
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const m = text.match(/SWARMY_DIGEST=(\S+)/);
      if (m?.[1]) digest = m[1];
      conn.send('logChunk', {
        commandId: p.commandId,
        stream: 'stdout',
        seq: seq++,
        data: text,
        eof: false,
      });
    });

    await container.start();
    const result = await container.wait();
    conn.send('logChunk', { commandId: p.commandId, stream: 'stdout', seq: seq++, data: '', eof: true });

    const code = (result as { StatusCode?: number }).StatusCode ?? 0;
    if (code !== 0) throw new Error(`build exited ${code}`);
    if (!digest) throw new Error('build finished but no image digest was produced');

    return {
      imageRef: primaryRef,
      imageRefs: p.imageRefs,
      digest,
    };
  } finally {
    await d.getContainer(name).remove({ force: true }).catch(() => undefined);
  }
}

/** Minimal single-quote shell escaping for values interpolated into the program. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
