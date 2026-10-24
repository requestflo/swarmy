/**
 * Who may wake what through the public activator. Pure over the gateway
 * store's maps so it is tested with literals.
 *
 * Only services that opted into scale-to-zero are wakeable (an operator's
 * deliberate stop at 0 stays stopped), and only through a signed wake path
 * (`@swarmy/core/wake-token`): the token names the org, so a name two orgs both
 * use wakes the right one, and an unsigned or forged link wakes nothing.
 */
import { SCALE_TO_ZERO_LABEL, SCALE_TO_ZERO_TARGET_LABEL } from '@swarmy/core';
import { verifyWakeToken } from '@swarmy/core/wake-token';

interface ServiceLike {
  name: string;
  labels: Record<string, string>;
  runningReplicas: number;
}

export interface WakeStore {
  serviceInfo: ReadonlyMap<string, readonly ServiceLike[]>;
  nodeOrg: ReadonlyMap<string, string>;
}

export interface Wakeable {
  orgId: string;
  running: number;
  target: number;
}

/** Every org running an opted-in service called `name`. */
function wakeableOrgs(store: WakeStore, name: string): Map<string, Wakeable> {
  const out = new Map<string, Wakeable>();
  for (const [nodeId, services] of store.serviceInfo) {
    const orgId = store.nodeOrg.get(nodeId);
    if (!orgId || out.has(orgId)) continue;
    const svc = services.find((s) => s.name === name && s.labels[SCALE_TO_ZERO_LABEL] === 'true');
    if (svc) {
      out.set(orgId, { orgId, running: svc.runningReplicas, target: Number(svc.labels[SCALE_TO_ZERO_TARGET_LABEL]) || 1 });
    }
  }
  return out;
}

/** The opted-in service `name` in `orgId`, as the live inventory sees it now. */
export function findWakeable(store: WakeStore, name: string, orgId: string): Wakeable | undefined {
  return wakeableOrgs(store, name).get(orgId);
}

/** The org a signed wake token belongs to, or undefined when no org's token matches. */
export function orgForWakeToken(store: WakeStore, name: string, token: string, secret?: string): string | undefined {
  for (const orgId of wakeableOrgs(store, name).keys()) {
    // An undefined secret falls through to the default (SWARMY_SECRET_KEY).
    if (verifyWakeToken(orgId, name, token, secret)) return orgId;
  }
  return undefined;
}
