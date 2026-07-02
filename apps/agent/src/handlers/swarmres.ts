/**
 * Swarm-resource handlers (platform buildout spine): Docker secrets, Docker
 * configs, and the one-shot utility container (`container.runOnce`).
 *
 * Secret/config data rides the already-authenticated WS base64-encoded and goes
 * straight into the Docker API — never written to disk on the node. Docker
 * never returns secret values; configs ARE readable back (`configInspect`).
 *
 * `runOnce` generalizes the short-lived sidecar pattern in `backup.ts`:
 * create container (optional pull) → start → wait (kill at `timeoutMs`) →
 * collect combined output tail (≤64KB) → force-remove.
 *
 * Wire types live in `@swarmy/core/protocol` (`swarmres.ts`). Results are
 * reported through the existing `commandResult` path.
 */
import type { DockerClient } from '@swarmy/core/docker';
import type {
  ConfigCreatePayload,
  ConfigCreateResult,
  ConfigInspectPayload,
  ConfigInspectResult,
  ConfigListResult,
  ConfigRemovePayload,
  ConfigRemoveResult,
  RunOncePayload,
  RunOnceResult,
  SecretCreatePayload,
  SecretCreateResult,
  SecretListResult,
  SecretRemovePayload,
  SecretRemoveResult,
} from '@swarmy/core/protocol';
import { RUN_ONCE_OUTPUT_TAIL_BYTES } from '@swarmy/core/protocol';

// ── secrets ──────────────────────────────────────────────────────────────────

export async function secretCreate(
  docker: DockerClient,
  p: SecretCreatePayload,
): Promise<SecretCreateResult> {
  const id = await docker.createSecret(p.name, p.dataB64, p.labels);
  return { id, name: p.name };
}

export async function secretRemove(
  docker: DockerClient,
  p: SecretRemovePayload,
): Promise<SecretRemoveResult> {
  await docker.removeSecret(p.name);
  return { name: p.name, removed: true };
}

export async function secretList(docker: DockerClient): Promise<SecretListResult> {
  return { secrets: await docker.listSecrets() };
}

// ── configs ──────────────────────────────────────────────────────────────────

export async function configCreate(
  docker: DockerClient,
  p: ConfigCreatePayload,
): Promise<ConfigCreateResult> {
  const id = await docker.createConfig(p.name, p.dataB64, p.labels);
  return { id, name: p.name };
}

export async function configRemove(
  docker: DockerClient,
  p: ConfigRemovePayload,
): Promise<ConfigRemoveResult> {
  await docker.removeConfig(p.name);
  return { name: p.name, removed: true };
}

export async function configList(docker: DockerClient): Promise<ConfigListResult> {
  return { configs: await docker.listConfigs() };
}

export async function configInspect(
  docker: DockerClient,
  p: ConfigInspectPayload,
): Promise<ConfigInspectResult> {
  const c = await docker.inspectConfig(p.name);
  return { name: c.name, dataB64: c.dataB64, labels: c.labels, createdAt: c.createdAt };
}

// ── container.runOnce ────────────────────────────────────────────────────────

/**
 * Run a one-shot utility container and return `{ exitCode, output }`. The
 * universal lever for trivy/cosign/wal-g/drills/scheduled image jobs. Env only
 * ever exists as process env inside the container (one-shot-secret contract);
 * output is the combined stdout+stderr tail, capped at 64KB.
 */
export async function runOnce(docker: DockerClient, p: RunOncePayload): Promise<RunOnceResult> {
  const d = docker.docker;
  const started = Date.now();
  if (p.pull) await docker.pullImage(p.image).catch(() => undefined);

  let output = '';
  const append = (s: string) => {
    output += s;
    if (output.length > RUN_ONCE_OUTPUT_TAIL_BYTES) {
      output = output.slice(output.length - RUN_ONCE_OUTPUT_TAIL_BYTES);
    }
  };

  const env = p.env ? Object.entries(p.env).map(([k, v]) => `${k}=${v}`) : undefined;
  const container = await d.createContainer({
    Image: p.image,
    Cmd: p.cmd,
    ...(p.entrypoint ? { Entrypoint: p.entrypoint } : {}),
    Env: env,
    HostConfig: {
      Binds: p.binds,
      AutoRemove: false,
      NetworkMode: p.networks?.[0],
    },
    Tty: false,
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Extra networks (the first rides HostConfig.NetworkMode) attach pre-start.
    for (const net of p.networks?.slice(1) ?? []) {
      await d.getNetwork(net).connect({ Container: container.id }).catch(() => undefined);
    }

    const stream = (await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    })) as unknown as NodeJS.ReadableStream;
    const sink = {
      write: (b: Buffer) => append(b.toString('utf8')),
    } as unknown as NodeJS.WritableStream;
    (d.modem as unknown as {
      demuxStream(s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream): void;
    }).demuxStream(stream, sink, sink);

    await container.start();
    if (p.timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        void container.kill().catch(() => undefined);
      }, p.timeoutMs);
    }
    const status = await container.wait();
    const exitCode = (status as { StatusCode?: number }).StatusCode ?? 0;
    return { exitCode, output, durationMs: Date.now() - started, timedOut };
  } finally {
    if (killTimer) clearTimeout(killTimer);
    await container.remove({ force: true }).catch(() => undefined);
  }
}
