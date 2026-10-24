/**
 * `reimageMesh`: move this node's NetBird client (`swarmy-netbird`) to
 * another image in place — the platform upgrade's mesh step, which the
 * controller runs one node at a time (plans/epic-platform-upgrades.md §2.4).
 *
 *   1. pull the new image FIRST (nothing is touched if that fails);
 *   2. stop the running client and keep it as `swarmy-netbird-prev`;
 *   3. start a clone of it on the new image (`reimageSpec`: same host
 *      network, caps, tun device and state volume — the peer identity and
 *      mesh IP survive, no setup key needed);
 *   4. wait for it to reconnect with the same mesh IP;
 *   5. yes → drop the old container; no → put the old one back HERE and
 *      fail. The rollback is local on purpose: the controller may reach this
 *      node over the very mesh that just went down.
 *
 * A crash between 2 and 5 is healed by the next call (`healInterrupted`).
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { ReimageMeshPayload, ReimageMeshResult } from '@swarmy/core/protocol';
import { sampleMeshState } from './mesh';
import { resolveMeshClientImage } from './mesh-image';
import { reconnected, reimageSpec, type ContainerInspectLite, type ImageConfigLite, type MeshSample } from './mesh-reimage-spec';

export const NETBIRD_CONTAINER = 'swarmy-netbird';
export const PREV_CONTAINER = 'swarmy-netbird-prev';

export interface ReimageDeps {
  sample: () => Promise<MeshSample | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaults = (docker: DockerClient): ReimageDeps => ({
  sample: () => sampleMeshState(docker),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});

async function waitBack(deps: ReimageDeps, before: string | undefined, timeoutMs: number): Promise<{ ok: boolean; why?: string; meshIp?: string }> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const s = await deps.sample().catch(() => null);
    const r = reconnected(s, before);
    if (r.ok) return { ok: true, meshIp: s?.meshIp };
    if (r.why?.startsWith('came back as a new peer') || deps.now() > deadline) return r;
    await deps.sleep(2_000);
  }
}

/** A previous call died mid-swap: keep whichever client runs, else bring the old one back. */
async function healInterrupted(d: DockerClient['docker']): Promise<void> {
  const prev = await d.getContainer(PREV_CONTAINER).inspect().catch(() => null);
  if (!prev) return;
  const cur = await d.getContainer(NETBIRD_CONTAINER).inspect().catch(() => null);
  if (cur?.State?.Running) {
    await d.getContainer(PREV_CONTAINER).remove({ force: true }).catch(() => undefined);
    return;
  }
  if (cur) await d.getContainer(NETBIRD_CONTAINER).remove({ force: true }).catch(() => undefined);
  await d.getContainer(PREV_CONTAINER).rename({ name: NETBIRD_CONTAINER });
  await d.getContainer(NETBIRD_CONTAINER).start().catch(() => undefined);
}

export async function reimageMeshClient(docker: DockerClient, p: ReimageMeshPayload, deps: ReimageDeps = defaults(docker)): Promise<ReimageMeshResult> {
  const d = docker.docker;
  await healInterrupted(d);
  const cur = await d.getContainer(NETBIRD_CONTAINER).inspect().catch(() => null);
  if (!cur) return { changed: false, reason: 'no-client' };
  const from = cur.Config.Image;
  const image = await resolveMeshClientImage(docker, p.image, { mirrorImage: p.mirrorImage, registryAuth: p.registryAuth });
  const next = await d.getImage(image).inspect().catch(() => null);
  if (!next) throw new Error(`could not pull ${image}; the mesh client was not touched`);
  if (next.Id === cur.Image) return { changed: false, reason: 'same-image', from, to: image };
  const oldImage = await d.getImage(cur.Image).inspect().catch(() => null);
  const before = (await deps.sample().catch(() => null))?.meshIp;

  const old = d.getContainer(cur.Id);
  await old.stop({ t: 10 }).catch(() => undefined);
  await old.rename({ name: PREV_CONTAINER });
  let why: string;
  try {
    const spec = reimageSpec(cur as unknown as ContainerInspectLite, (oldImage?.Config ?? null) as ImageConfigLite | null, image, NETBIRD_CONTAINER);
    const created = await d.createContainer(spec as never);
    await created.start();
    const back = await waitBack(deps, before, p.reconnectTimeoutMs);
    if (back.ok) {
      await old.remove({ force: true }).catch(() => undefined);
      return { changed: true, from, to: image, ...(back.meshIp ? { meshIp: back.meshIp } : {}) };
    }
    why = `the mesh client on ${image} ${back.why === 'not connected yet' ? `did not reconnect within ${Math.round(p.reconnectTimeoutMs / 1000)} s` : back.why}`;
  } catch (e) {
    why = `the mesh client on ${image} would not start (${e instanceof Error ? e.message : String(e)})`;
  }
  // Put the old client back, here and now.
  await d.getContainer(NETBIRD_CONTAINER).remove({ force: true }).catch(() => undefined);
  await old.rename({ name: NETBIRD_CONTAINER });
  await old.start().catch(() => undefined);
  const again = await waitBack(deps, before, 60_000);
  throw Object.assign(new Error(`${why}; the previous client (${from}) is back${again.ok ? ' and reconnected' : ', not reconnected yet'}`), {
    code: 'E_MESH_REIMAGE',
  });
}
