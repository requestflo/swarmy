// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent self-update (`updateAgent` command).
 *
 * Two strategies, matching the two install backends:
 *
 * - `self-replace` (systemd host binary): download the new binary NEXT TO the
 *   current one (same filesystem → atomic rename), verify its sha256 against
 *   the payload, exec `--version` as a sanity check, keep the old binary at
 *   `<bin>.old` for rollback, swap, then exit and let systemd
 *   (`Restart=always`) bring the new binary up. The command result is sent
 *   BEFORE the exit so the controller sees `succeeded`, then the reconnect
 *   with the new `agentVersion` in the register facts confirms it.
 *
 * - `docker-recreate` (container backend): pull the new image, rename our own
 *   `swarmy-agent` container aside, create + start a replacement with the same
 *   env/binds/restart-policy on the new image, then force-remove the old
 *   container (ourselves) — the removal kills this process after the result
 *   has flushed; the new agent's register closes any stale socket
 *   (DUPLICATE_SESSION) anyway.
 *
 * A binary can never brick the node silently: every failure path answers the
 * command, and a half-done swap rolls back to `<bin>.old`.
 */
import { chmod, rename, rm, stat } from 'node:fs/promises';
import type { DockerClient } from '@swarmy/core/docker';
import type { UpdateAgentMsg } from '@swarmy/core/protocol';

type Payload = UpdateAgentMsg['payload'];

/** How this agent is running: compiled standalone binary vs interpreted (container/dev). */
export function agentPackaging(): 'binary' | 'container' {
  // Bun embeds the entrypoint in a virtual filesystem for compiled executables.
  return Bun.main.startsWith('/$bunfs') || Bun.main.startsWith('B:\\') ? 'binary' : 'container';
}

const EXIT_FLUSH_MS = 750;

export async function updateAgent(
  docker: DockerClient,
  payload: Payload,
): Promise<{ targetVersion: string; strategy: string; restarting: true }> {
  if (payload.strategy === 'self-replace') {
    await selfReplace(payload);
  } else {
    await dockerRecreate(docker, payload);
  }
  return { targetVersion: payload.targetVersion, strategy: payload.strategy, restarting: true };
}

async function selfReplace(payload: Payload): Promise<void> {
  if (agentPackaging() !== 'binary') {
    throw new Error(
      'self-replace requires the compiled host binary; this agent runs interpreted — use the docker-recreate strategy',
    );
  }
  await selfReplaceAt(payload, process.execPath);
  scheduleExit();
}

/** The swap mechanics, binPath-injectable for tests (which must neither be a compiled binary nor exit). */
export async function selfReplaceAt(payload: Payload, binPath: string): Promise<void> {
  const { downloadUrl, sha256 } = payload;
  if (!downloadUrl || !sha256) throw new Error('self-replace requires downloadUrl + sha256');
  const downloadPath = `${binPath}.download`;
  const oldPath = `${binPath}.old`;

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${downloadUrl}`);
  await Bun.write(downloadPath, res);

  try {
    const actual = await sha256File(downloadPath);
    if (actual !== sha256) {
      throw new Error(`checksum mismatch: expected ${sha256}, got ${actual}`);
    }
    await chmod(downloadPath, 0o755);

    // The downloaded binary must at least start and identify itself before we
    // trust it with the node.
    const probe = Bun.spawn([downloadPath, '--version'], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(probe.stdout).text();
    if ((await probe.exited) !== 0 || !out.includes('swarmy-agent')) {
      throw new Error(`downloaded binary failed --version sanity check: ${out.trim() || 'no output'}`);
    }
  } catch (e) {
    await rm(downloadPath, { force: true });
    throw e;
  }

  // Swap. Keep the running binary at .old — if the new one crash-loops, an
  // operator (or a future watchdog) can swap it straight back.
  await rm(oldPath, { force: true });
  await rename(binPath, oldPath);
  try {
    await rename(downloadPath, binPath);
  } catch (e) {
    await rename(oldPath, binPath); // roll back — never leave the node binary-less
    throw e;
  }
}

async function dockerRecreate(docker: DockerClient, payload: Payload): Promise<void> {
  const image = payload.image;
  if (!image) throw new Error('docker-recreate requires an image in the payload');
  await docker.pullImage(image);

  const self = await findOwnContainer(docker);
  const inspect = await self.inspect();
  const name = (inspect.Name ?? '/swarmy-agent').replace(/^\//, '');

  await self.rename({ name: `${name}-old` });
  try {
    const replacement = await docker.docker.createContainer({
      name,
      Image: image,
      Env: inspect.Config.Env,
      Labels: inspect.Config.Labels,
      HostConfig: {
        Binds: inspect.HostConfig?.Binds ?? undefined,
        Mounts: inspect.HostConfig?.Mounts ?? undefined,
        RestartPolicy: inspect.HostConfig?.RestartPolicy ?? { Name: 'unless-stopped' },
        NetworkMode: inspect.HostConfig?.NetworkMode ?? undefined,
      },
    });
    await replacement.start();
  } catch (e) {
    await self.rename({ name }).catch(() => undefined); // roll the name back
    throw e;
  }

  // Removing our own container kills this process — after the result flushes.
  setTimeout(() => {
    void self.remove({ force: true }).catch(() => process.exit(0));
  }, EXIT_FLUSH_MS);
}

/** Resolve the container this agent runs in: by conventional name, else by $HOSTNAME (= container id). */
async function findOwnContainer(docker: DockerClient) {
  const byName = docker.docker.getContainer('swarmy-agent');
  try {
    await byName.inspect();
    return byName;
  } catch {
    const hostname = process.env.HOSTNAME ?? '';
    if (!hostname) throw new Error('cannot locate own container (no swarmy-agent container, no HOSTNAME)');
    const byId = docker.docker.getContainer(hostname);
    await byId.inspect(); // throws if wrong
    return byId;
  }
}

async function sha256File(path: string): Promise<string> {
  const file = Bun.file(path);
  await stat(path); // surface a clean error if the download vanished
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await file.arrayBuffer());
  return hasher.digest('hex');
}

function scheduleExit(): void {
  setTimeout(() => process.exit(0), EXIT_FLUSH_MS);
}
