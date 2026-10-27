/**
 * How a batch of system images is copied into an org's registry: one regctl
 * one-shot per image, each carrying what it copies as its `copyKey` (the
 * source `<image@digest>`, `copySourceFor`). The agent labels the container
 * `swarmy.copy.key=<key>` and, before starting one, waits on a copy with the
 * same key already running on the node. That covers what the in-process
 * flights (system-images-flights.ts) cannot: a controller restart mid-copy,
 * after which the next preflight would otherwise start the same copy again.
 *
 * A copy the agent found already running comes back `alreadyRunning`. Its
 * output counts when it could be read back; a key it does not settle is in
 * flight — neither copied nor failed — and the next mirror tick stamps it
 * once it has landed.
 */
import type { RunOnceResult } from '@swarmy/core/protocol';
import { copySourceFor, parseMirrorOutput, renderMirrorScript, systemImage, type SystemImage, type SystemImageKey } from '@swarmy/core/system-images';
import type { CopyBatch, CopyOutcome } from './system-images-flights';

/** A copy one-shot's runOnce payload (minus routing). */
export function copyPayload(img: SystemImage, registryHost: string, creds: { username: string; password: string } | null) {
  return {
    image: systemImage('regctl').ref,
    entrypoint: ['/bin/sh', '-c'],
    cmd: [renderMirrorScript([img], registryHost)],
    env: creds ? { SWARMY_REG_USER: creds.username, SWARMY_REG_PASS: creds.password } : {},
    networks: ['host'],
    timeoutMs: 45 * 60_000,
    copyKey: copySourceFor(img),
  };
}

/** One image's outcome from its one-shot's result. */
export function copyVerdict(key: SystemImageKey, res: RunOnceResult): { digest: string } | 'failed' | 'in-flight' {
  const out = parseMirrorOutput(res.output ?? '');
  const digest = out.ok.get(key);
  if (digest) return { digest };
  if (res.alreadyRunning && !out.failed.includes(key)) return 'in-flight';
  return 'failed';
}

/**
 * A {@link CopyBatch} over `run` (one dispatch per image, in order). A
 * dispatch that throws fails that image only; when every one throws, the
 * batch rejects with the first error (the agent is unreachable).
 */
export function copyEachVia(
  run: (payload: ReturnType<typeof copyPayload>) => Promise<RunOnceResult>,
  registryHost: string,
  creds: { username: string; password: string } | null,
): CopyBatch {
  return async (items) => {
    const outcome: CopyOutcome = { ok: new Map(), failed: [], inFlight: [] };
    let firstError: unknown;
    let answered = 0;
    for (const img of items) {
      let res: RunOnceResult;
      try {
        res = await run(copyPayload(img, registryHost, creds));
        answered++;
      } catch (e) {
        firstError ??= e;
        outcome.failed.push(img.key);
        continue;
      }
      const v = copyVerdict(img.key, res);
      if (v === 'failed') outcome.failed.push(img.key);
      else if (v === 'in-flight') outcome.inFlight!.push(img.key);
      else outcome.ok.set(img.key, v.digest);
    }
    if (answered === 0 && items.length > 0) throw firstError;
    return outcome;
  };
}

/**
 * The upgrade preflight's line about pre-copying the release's images. An
 * image a copy from before a controller restart is still copying is in
 * flight: neither failed nor copied again.
 */
export function mirrorNote(r: { copied: string[]; failed: string[]; inFlight?: string[]; skipped?: string }): string {
  if (r.skipped) return `images not pre-copied (${r.skipped}); nodes pull them from upstream`;
  const inFlight = r.inFlight?.length ?? 0;
  return (
    `release images in the cluster registry: ${r.copied.length} copied` +
    (inFlight ? `, ${inFlight} still copying (started before a controller restart)` : '') +
    (r.failed.length ? `, ${r.failed.length} failed (upstream fallback)` : '')
  );
}
