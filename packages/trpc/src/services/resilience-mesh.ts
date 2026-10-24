/**
 * The Resilience check for the private network's own control plane (plan
 * §2.5 "the same Resilience card", M1): the NetBird that runs in swarmy. Every
 * server rides it, so losing its node with no backup means no move, no new
 * server, no sign-ins, and peers that restart stay off. Pure classifier plus
 * a cheap live read (managed doc + the hosting node's own report; never an
 * API call to NetBird).
 */
import type { ResilienceProblemView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { meshConfigRepo } from './mesh-config.repo';
import { managedOf } from './mesh-control.service';
import { meshControlLive } from './mesh-peers';

export interface MeshControlSignal {
  /** The control plane runs in swarmy (absent signal = external / no mesh). */
  managed: true;
  /** A Litestream replica is configured (object storage on). */
  backedUp: boolean;
  /** The hosting node reports its Litestream writer running (null = no report yet). */
  replicating: boolean | null;
  /** Its name can follow a move (not an IP-pinned sslip.io name). */
  movable: boolean;
  /** Relayed traffic is carried by the edges (null = not possible: NetBird isn't behind swarmy's edge). */
  relaysOnEdges: boolean | null;
}

const MESH_SETTINGS = '/networking/settings';

export function meshControlProblems(s: MeshControlSignal | undefined): ResilienceProblemView[] {
  if (!s) return [];
  const out: ResilienceProblemView[] = [];
  const p = (id: string, severity: ResilienceProblemView['severity'], f: Omit<ResilienceProblemView, 'id' | 'check' | 'severity' | 'resource'>) =>
    out.push({ id: `mesh-control/${id}`, check: 'mesh-control', severity, resource: null, ...f });
  if (!s.backedUp) {
    p('backup', 'warn', {
      title: "The private network's control plane isn't backed up",
      detail: 'If its server is lost, nothing can move it: no new servers, no sign-ins, and servers that restart stay off the network.',
      fixHint: 'Turn on object storage; swarmy then streams the control plane to it continuously.',
      fixPath: '/data/buckets',
      fixLabel: 'Turn on object storage',
    });
  } else if (s.replicating === false) {
    p('backup', 'warn', {
      title: "The private network's backup has stopped",
      detail: 'The control plane runs, but its continuous copy to object storage does not.',
      fixHint: 'Open Mesh settings and sync the control plane; check that object storage is reachable.',
      fixPath: MESH_SETTINGS,
      fixLabel: 'Open Mesh settings',
    });
  }
  if (!s.movable) {
    p('movable', 'info', {
      title: "The private network's address follows one server",
      detail: 'Its name is tied to that server, so moving the control plane means everyone signs in again.',
      fixHint: 'Put the mesh on a domain you control (mesh.<your zone>) so a move keeps it.',
      fixPath: MESH_SETTINGS,
      fixLabel: 'Open Mesh settings',
    });
  }
  if (s.relaysOnEdges === false) {
    p('relays', 'info', {
      title: 'Relayed traffic goes through one server',
      detail: "Servers that can't reach each other directly lose that path while the control plane's server is down.",
      fixHint: 'Turn on relays on front doors in Mesh settings.',
      fixPath: MESH_SETTINGS,
      fixLabel: 'Open Mesh settings',
    });
  }
  return out;
}

export async function meshControlSignal(ctx: OrgContext): Promise<MeshControlSignal | undefined> {
  const row = await meshConfigRepo.get(ctx, ctx.activeOrgId);
  const m = managedOf(row);
  if (!m || !row.enabled) return undefined;
  const live = meshControlLive.get(ctx.activeOrgId)?.status;
  return {
    managed: true,
    backedUp: Boolean(m.litestream),
    replicating: live ? Boolean(live.litestream?.running) : null,
    movable: !m.meshDomain.endsWith('.sslip.io'),
    relaysOnEdges: m.tls.mode === 'edge' ? Boolean(m.relays) : null,
  };
}
