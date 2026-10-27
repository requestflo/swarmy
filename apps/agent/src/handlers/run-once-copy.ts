/**
 * `container.runOnce` with a `copyKey` — the platform's image copies into the
 * cluster registry — runs at most one container per key on this node.
 *
 * The controller shares a copy already in flight in-process
 * (system-images-flights.ts), but a controller restart mid-copy forgets that:
 * the copy container keeps running here, and the next preflight would start a
 * second one. So before starting a copy the agent
 *
 *  1. joins its own run of that key still in flight (the controller went away,
 *     this process did not) and returns the same result;
 *  2. else waits on a RUNNING container labelled `swarmy.copy.key=<key>` (one
 *     an earlier agent process started), reads its output back once it ends
 *     and removes it;
 *
 * and only then starts its own, labelled with the key. Both joined paths set
 * `alreadyRunning`. Output that can't be read back (the copy's owner removed
 * it first, or the wait outlasted `timeoutMs`) comes back empty, which the
 * controller treats as still in flight, never as failed.
 */
import type { DockerClient } from '@swarmy/core/docker';
import { COPY_KEY_LABEL, RUN_ONCE_OUTPUT_TAIL_BYTES, type RunOnceResult } from '@swarmy/core/protocol';
import { demuxDockerStream } from './exec';

export type StartCopy = (labels: Record<string, string>) => Promise<RunOnceResult>;

const IN_FLIGHT = new Map<string, Promise<RunOnceResult>>();

export async function runCopyOnce(
  docker: DockerClient,
  key: string,
  timeoutMs: number | undefined,
  start: StartCopy,
  flights: Map<string, Promise<RunOnceResult>> = IN_FLIGHT,
): Promise<RunOnceResult> {
  const mine = flights.get(key);
  if (mine) return { ...(await mine), alreadyRunning: true };
  const run = (async () => {
    const running = await runningCopy(docker, key);
    if (running) return awaitCopy(docker, running, timeoutMs);
    return start({ [COPY_KEY_LABEL]: key });
  })();
  flights.set(key, run);
  try {
    return await run;
  } finally {
    if (flights.get(key) === run) flights.delete(key);
  }
}

/** The id of a running copy container with this key, if any (a failed listing reads as none). */
async function runningCopy(docker: DockerClient, key: string): Promise<string | undefined> {
  try {
    const list = (await docker.docker.listContainers({
      all: false,
      filters: { label: [`${COPY_KEY_LABEL}=${key}`] },
    })) as Array<{ Id: string; State?: string }>;
    return list.find((c) => !c.State || c.State === 'running')?.Id;
  } catch {
    return undefined;
  }
}

const TIMEOUT = Symbol('timeout');

/** Wait for a copy this process didn't start, then read its output back and remove it. */
async function awaitCopy(docker: DockerClient, id: string, timeoutMs: number | undefined): Promise<RunOnceResult> {
  const started = Date.now();
  const c = docker.docker.getContainer(id);
  const done = (r: Omit<RunOnceResult, 'durationMs' | 'alreadyRunning'>): RunOnceResult => ({
    ...r,
    durationMs: Date.now() - started,
    alreadyRunning: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: { StatusCode?: number } | typeof TIMEOUT;
  try {
    const wait = c.wait() as Promise<{ StatusCode?: number }>;
    status = timeoutMs
      ? await Promise.race([wait, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), timeoutMs)))])
      : await wait;
  } catch {
    // Gone before we could wait: its owner removed it. Nothing to read back.
    return done({ exitCode: -1, output: '' });
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Still copying past our budget: leave it running; the next caller finds it again.
  if (status === TIMEOUT) return done({ exitCode: -1, output: '', timedOut: true });
  let output = '';
  try {
    const raw = (await c.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
    const d = demuxDockerStream(Buffer.from(raw));
    output = `${d.stdout}${d.stderr}`.slice(-RUN_ONCE_OUTPUT_TAIL_BYTES);
  } catch {
    output = '';
  }
  await c.remove({ force: true }).catch(() => undefined);
  return done({ exitCode: status.StatusCode ?? 0, output });
}
