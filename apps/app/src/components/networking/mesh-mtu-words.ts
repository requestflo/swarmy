/**
 * Words and the manual steps for "Networks are too big for the mesh" (Mesh
 * settings). Pure, so the sentences and the commands are golden-tested. The
 * numbers come from the controller's check (`mesh.mtu`, @swarmy/core
 * overlay-mtu-check.ts); nothing here does arithmetic of its own.
 */

/** The parts of the `mesh.mtu` view the page reads. */
export interface MtuFindingLike {
  name: string;
  encrypted: boolean;
  managed: boolean;
  ingress: boolean;
  stack?: string;
  mtu: number;
  fits: number;
  recreate: string;
}

export interface MtuViewLike {
  status: 'ok' | 'too-big' | 'unknown';
  iface: string | null;
  linkMtu: number | null;
  option: number | null;
  fits: { plain: number; encrypted: number } | null;
  tooBig: MtuFindingLike[];
  services: Record<string, string[]>;
}

const plural = (k: number, one: string, many: string): string => (k === 1 ? one : many);

export function mtuLede(v: MtuViewLike): string {
  const k = v.tooBig.length;
  const biggest = Math.max(...v.tooBig.map((f) => f.mtu));
  return (
    `The private network carries packets of up to ${v.linkMtu} bytes. ${k} ${plural(k, 'network sends', 'networks send')} up to ${biggest}, ` +
    'so large transfers between servers can stall while small ones still work.'
  );
}

export function mtuFixLine(v: MtuViewLike): string {
  const encrypted = v.tooBig.some((f) => f.encrypted);
  const them = plural(v.tooBig.length, 'it', 'them');
  return `Fix: set ${them} to ${v.fits?.plain}${encrypted ? ` (${v.fits?.encrypted} encrypted)` : ''}. Networks swarmy creates from now on already fit.`;
}

export const MTU_MANUAL_STEP =
  "A network's size is fixed when it's created, and recreating one takes the apps on it offline for a moment, so swarmy " +
  'leaves it to you. When they can take a break: detach the services on it, remove it, create it again at the right ' +
  'size, then deploy those apps again. Controls shows the exact commands.';

/** What a row says under the network's name. */
export function mtuRowSub(f: MtuFindingLike, services: readonly string[]): string {
  if (f.ingress) return "Docker's network for published ports";
  if (!services.length) return 'nothing on it right now';
  return services.length > 3 ? `${services.slice(0, 3).join(', ')} +${services.length - 3}` : services.join(', ');
}

/** The exact Docker commands for one network, in order. */
export function mtuSteps(f: MtuFindingLike, services: readonly string[]): string {
  const out = [`# ${f.name}: ${f.mtu} now, fits at ${f.fits}`];
  for (const s of services) out.push(`docker service update --network-rm ${f.name} ${s}`);
  out.push(`docker network rm ${f.name}`, f.recreate);
  if (f.managed && f.stack) {
    out.push(`# then deploy ${f.stack} again in swarmy: it re-attaches its services with their short names`);
  } else {
    for (const s of services) out.push(`docker service update --network-add ${f.name} ${s}`);
  }
  return out.join('\n');
}

export function mtuAllSteps(v: MtuViewLike): string {
  return v.tooBig.map((f) => mtuSteps(f, v.services[f.name] ?? [])).join('\n\n');
}
