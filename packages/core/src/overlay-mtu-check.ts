/**
 * "Are the overlays too big for the mesh?" — the pure check behind Mesh
 * settings. Inputs are what an agent sees (its WireGuard interface MTU and the
 * overlay networks its Docker knows); the numbers come from overlay-mtu.ts.
 * PURE (browser-safe).
 */
import {
  OVERLAY_MTU_OPTION,
  overlayContainerMtu,
  overlayFrameBytes,
  parseMtuOption,
} from './overlay-mtu';

/** One overlay network as an agent reports it (`meshState.overlays`). */
export interface OverlayMtuSample {
  name: string;
  /** The `com.docker.network.driver.mtu` option it was created with; absent = Docker's 1500. */
  mtu?: number;
  encrypted: boolean;
  attachable: boolean;
  /** Created by swarmy (`swarmy.managed=true`). */
  managed: boolean;
  /** Docker's routing-mesh network (`--ingress`). */
  ingress: boolean;
  /** `com.docker.stack.namespace`, when it belongs to an app. */
  stack?: string;
}

/** Docker's network list entry, the fields the sampler reads. */
export interface DockerNetworkLike {
  Name?: string;
  Driver?: string;
  Attachable?: boolean;
  Ingress?: boolean;
  Options?: Record<string, string> | null;
  Labels?: Record<string, string> | null;
}

/** Docker's overlay networks → samples (other drivers dropped), sorted by name. */
export function overlaySamplesFrom(nets: readonly DockerNetworkLike[]): OverlayMtuSample[] {
  return nets
    .filter((n) => n.Driver === 'overlay' && !!n.Name)
    .map((n) => {
      const mtu = parseMtuOption(n.Options?.[OVERLAY_MTU_OPTION]);
      const stack = n.Labels?.['com.docker.stack.namespace'];
      return {
        name: n.Name!,
        ...(mtu ? { mtu } : {}),
        encrypted: !!n.Options && 'encrypted' in n.Options,
        attachable: n.Attachable === true,
        managed: n.Labels?.['swarmy.managed'] === 'true',
        ingress: n.Ingress === true,
        ...(stack ? { stack } : {}),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface OverlayMtuFinding {
  name: string;
  encrypted: boolean;
  managed: boolean;
  ingress: boolean;
  stack?: string;
  /** What its containers get now. */
  mtu: number;
  /** The most that fits the link. */
  fits: number;
  /** `docker network create …` that makes it fit (once nothing is attached to the old one). */
  recreate: string;
}

export interface MeshMtuCheck {
  /** `unknown` until an agent has reported both the interface MTU and its overlays. */
  status: 'ok' | 'too-big' | 'unknown';
  iface: string | null;
  linkMtu: number | null;
  /** The option overlays need on this mesh (= the link MTU; Docker subtracts the rest). */
  option: number | null;
  /** The most a container may use: plain / encrypted overlays. */
  fits: { plain: number; encrypted: number } | null;
  checked: number;
  tooBig: OverlayMtuFinding[];
}

function recreateLine(o: OverlayMtuSample, option: number): string {
  const opt = `--opt ${OVERLAY_MTU_OPTION}=${option}`;
  if (o.ingress) return `docker network create --driver overlay --ingress ${opt} ${o.name}`;
  return [
    'docker network create --driver overlay',
    o.attachable ? '--attachable' : null,
    o.encrypted ? '--opt encrypted' : null,
    opt,
    o.managed ? '--label swarmy.managed=true' : null,
    o.stack ? `--label com.docker.stack.namespace=${o.stack}` : null,
    o.name,
  ]
    .filter(Boolean)
    .join(' ');
}

export function checkOverlayMtu(input: {
  iface?: string | null;
  linkMtu?: number | null;
  /** `null` = no agent has reported its overlays yet (older agents). */
  overlays: readonly OverlayMtuSample[] | null;
}): MeshMtuCheck {
  const iface = input.iface ?? null;
  const link = input.linkMtu && input.linkMtu > 0 ? input.linkMtu : null;
  if (!link || !input.overlays) {
    return { status: 'unknown', iface, linkMtu: link, option: link, fits: null, checked: 0, tooBig: [] };
  }
  const fits = { plain: overlayContainerMtu(link, false), encrypted: overlayContainerMtu(link, true) };
  const tooBig: OverlayMtuFinding[] = [];
  for (const o of input.overlays) {
    const mtu = overlayContainerMtu(o.mtu, o.encrypted);
    if (overlayFrameBytes(mtu, o.encrypted) <= link) continue;
    tooBig.push({
      name: o.name,
      encrypted: o.encrypted,
      managed: o.managed,
      ingress: o.ingress,
      ...(o.stack ? { stack: o.stack } : {}),
      mtu,
      fits: o.encrypted ? fits.encrypted : fits.plain,
      recreate: recreateLine(o, link),
    });
  }
  tooBig.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { status: tooBig.length ? 'too-big' : 'ok', iface, linkMtu: link, option: link, fits, checked: input.overlays.length, tooBig };
}
