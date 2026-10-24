/**
 * Pure half of `reimageMesh` (mesh-reimage.ts): the create options that
 * clone the running NetBird client container onto another image, and the
 * "did it come back" rule.
 *
 * The clone keeps what was set when the container was created — the whole
 * HostConfig (host network, caps, `/dev/net/tun`, the `swarmy-netbird` state
 * volume, the installer's key-file bind), and the env / command / labels the
 * creator added — but NOT what the OLD image baked in (its ENV, CMD,
 * ENTRYPOINT, labels): those come from the new image, or a NetBird release
 * that changes a default would keep running the old one.
 */

export interface ContainerInspectLite {
  Id: string;
  Image: string;
  Config: { Image?: string; Env?: string[] | null; Cmd?: string[] | null; Entrypoint?: string[] | null; Labels?: Record<string, string> | null };
  HostConfig?: Record<string, unknown>;
}

export interface ImageConfigLite {
  Env?: string[] | null;
  Cmd?: string[] | null;
  Entrypoint?: string[] | null;
  Labels?: Record<string, string> | null;
}

const same = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** `createContainer` options for `name` on `image`, cloned from `cur` minus what `oldImage` baked in. Pure. */
export function reimageSpec(cur: ContainerInspectLite, oldImage: ImageConfigLite | null, image: string, name: string): Record<string, unknown> {
  const baked = new Set(oldImage?.Env ?? []);
  const env = (cur.Config.Env ?? []).filter((e) => !baked.has(e));
  const bakedLabels = oldImage?.Labels ?? {};
  const labels = Object.fromEntries(Object.entries(cur.Config.Labels ?? {}).filter(([k, v]) => bakedLabels[k] !== v));
  return {
    name,
    Image: image,
    Env: env,
    ...(cur.Config.Cmd && !same(cur.Config.Cmd, oldImage?.Cmd) ? { Cmd: cur.Config.Cmd } : {}),
    ...(cur.Config.Entrypoint && !same(cur.Config.Entrypoint, oldImage?.Entrypoint) ? { Entrypoint: cur.Config.Entrypoint } : {}),
    ...(Object.keys(labels).length ? { Labels: labels } : {}),
    HostConfig: cur.HostConfig ?? {},
  };
}

export interface MeshSample {
  driver?: string;
  connected: boolean;
  meshIp?: string;
}

/**
 * Is the new client back? Connected to its management server with a mesh IP —
 * and the SAME IP as before when one was known: a different IP is a new peer
 * (the identity on the volume was not picked up), which a swarm advertising
 * the old IP can't survive. Pure.
 */
export function reconnected(s: MeshSample | null, before: string | undefined): { ok: boolean; why?: string } {
  if (!s || s.driver !== 'netbird' || !s.connected || !s.meshIp) return { ok: false, why: 'not connected yet' };
  if (before && s.meshIp !== before) return { ok: false, why: `came back as a new peer (${s.meshIp}, was ${before})` };
  return { ok: true };
}
