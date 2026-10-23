import type { NodeSummary } from '@swarmy/core';
import type { MeshState } from '@/components/estate-map/estate-model';
import type { Rings } from './fleet-model';

/**
 * The inspector's story: a server in two or three plain sentences — what it
 * does and where, how much of yours runs there, how it's doing, and how it's
 * reached. Pure; only numbers swarmy has (no traffic or cost guesses).
 */

const list = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export interface StoryInput {
  node: Pick<NodeSummary, 'role' | 'ingress' | 'database' | 'storage' | 'builder' | 'region' | 'status' | 'publicIp'>;
  rings: Rings;
  nat: boolean;
  mesh: MeshState;
  /** Your services here (swarmy's own parts left out); undefined while unknown. */
  yours: number | undefined;
  diskHotPct: number;
}

export function serverStory(i: StoryInput): string {
  const n = i.node;
  const does: string[] = [];
  if (n.role === 'manager') does.push('runs swarmy itself');
  if (n.ingress) does.push('serves your visitors');
  if (n.database) does.push('holds databases');
  if (n.storage) does.push('holds files');
  if (n.builder) does.push('builds your apps');
  if (does.length === 0) does.push('runs your apps');
  const out = [`${cap(list(does))}${n.region ? ` in ${n.region}` : ''}.`];

  if (i.yours !== undefined && n.status !== 'offline') {
    out.push(i.yours === 0 ? 'None of your services run here yet.' : `${i.yours} of your services run${i.yours === 1 ? 's' : ''} here.`);
  }

  const { cpu, mem, disk } = i.rings;
  const busy = cpu !== null && mem !== null ? (cpu >= mem ? { which: 'CPU', pct: cpu } : { which: 'memory', pct: mem }) : null;
  if (n.status === 'offline') out.push('It stopped answering.');
  else if (n.status === 'draining') out.push('It’s being emptied: its apps are moving to your other servers.');
  else if (disk !== null && disk >= i.diskHotPct) out.push(`Its disk is ${disk}% full.`);
  else if (busy && busy.pct >= 85) out.push(`It’s busy: ${busy.which} at ${busy.pct}%.`);
  else if (busy && disk !== null && Math.max(busy.pct, disk) < 60) out.push('There’s plenty of room.');

  if (i.nat) {
    out.push(i.mesh !== 'off' ? 'Nothing on the internet can reach it; swarmy talks to it over the private network.' : 'Nothing on the internet can reach it directly.');
  } else if (!n.publicIp) {
    out.push(i.mesh !== 'off' ? 'It has no public address and is reached over the private network.' : 'It has no public address.');
  }
  return out.join(' ');
}
