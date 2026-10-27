import {
  DB_AVOID_NODE_LABEL,
  DB_FAILOVER_CONFIRM_LABEL,
  DB_FAILOVER_PENDING_LABEL,
  DB_FAILOVER_PROMOTING_LABEL,
  DB_PIN_NODE_LABEL,
  DB_ROLE_PLACED_LABEL,
  DB_SWITCHOVER_LABEL,
  applyPgMember,
  needsReshape,
} from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';

/**
 * After the promotion pass promoted ONE copy of a standby service that holds
 * several (manageddb-copies), one name still covers a writer and standbys.
 * The reshape makes that name one writer again, over the next ticks:
 *
 *   1. the pass scales the promoted service to 0, keeping the
 *      `swarmy.db.failover.promoting=<node>` mark (every copy stops; the
 *      promoted data stays on that server's volume);
 *   2. once nothing of it runs, it is redeployed as ONE copy pinned to that
 *      server (`swarmy.db.node`), its env unchanged: the boot layer finds
 *      writer data under the same rejoin epoch and starts it as the writer.
 *      Stopping first means two postmasters never share that data directory.
 *
 * The other copies' volumes keep their data on their servers. When the
 * demoted writer is the cluster's base standby from now on, it takes over
 * the standby copies: floating (no pin), off the new writer's server, as many
 * as declared ({@link floatedExWriter}); a copy that lands on its old server
 * moves the old writer data aside first (the repoint's new epoch).
 */

const ROLE = 'swarmy.db.role';
const LEADER = 'swarmy.db.leader';
const REGION = 'swarmy.db.region';

function envRecord(env: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of env) {
    const i = kv.indexOf('=');
    out[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
  }
  return out;
}

/** The promoted service as one writer copy pinned to `node`. Pure. */
export function promotedCopySpec(s: SwarmServiceInfo, node: string, net: string): ServiceSpec {
  const labels: Record<string, string> = { ...s.labels, [ROLE]: 'primary', [LEADER]: s.name, [DB_PIN_NODE_LABEL]: node };
  for (const k of [DB_AVOID_NODE_LABEL, DB_ROLE_PLACED_LABEL, DB_FAILOVER_PROMOTING_LABEL, DB_FAILOVER_PENDING_LABEL, DB_FAILOVER_CONFIRM_LABEL, DB_SWITCHOVER_LABEL]) {
    delete labels[k];
  }
  const networks = (s.networks ?? []).map((n) => n.name).filter((n) => n.length > 0);
  const region = s.labels[REGION];
  return applyPgMember<ServiceSpec>(
    {
      name: s.name,
      image: s.image,
      mode: { replicated: { replicas: 1 } },
      env: envRecord(s.env),
      labels,
      networks: networks.length > 0 ? networks : [net],
      updateConfig: { parallelism: 1, order: 'stop-first' },
      ...((s.secrets ?? []).length > 0 ? { secrets: (s.secrets ?? []).map((n) => ({ source: n })) } : {}),
      ...((s.configs ?? []).length > 0 ? { configs: (s.configs ?? []).map((n) => ({ source: n })) } : {}),
      ...(region ? { placement: { constraints: [`node.labels.swarmy.region==${region}`] } } : {}),
    },
    labels,
  );
}

/** The demoted writer as the floating standby service (feed it to the repoint). Pure. */
export function floatedExWriter(p: SwarmServiceInfo, writerNode: string, copies: number): SwarmServiceInfo {
  const labels: Record<string, string> = { ...p.labels, [DB_AVOID_NODE_LABEL]: writerNode };
  delete labels[DB_PIN_NODE_LABEL];
  return { ...p, labels, desiredReplicas: Math.max(1, copies) };
}

export type ReshapeStep = 'none' | 'stop' | 'wait' | 'pin' | 'unmark';

/**
 * What the writer carrying the promoting mark needs this tick. Pure.
 * `unmark`: a 1-copy promotion whose mark wasn't dropped (nothing to
 * reshape). `stop`: copies are still wanted. `wait`: stopping. `pin`: none
 * left, start the one writer copy.
 */
export function reshapeStep(w: Pick<SwarmServiceInfo, 'labels' | 'desiredReplicas' | 'runningReplicas'>, runningCopies: number): ReshapeStep {
  if (w.labels[ROLE] !== 'primary' || !w.labels[DB_FAILOVER_PROMOTING_LABEL]) return 'none';
  const copies = Math.max(runningCopies, w.runningReplicas ?? 0);
  const desired = w.desiredReplicas ?? 0;
  if (!needsReshape({ desiredReplicas: desired, runningReplicas: copies }) && desired === 1) return 'unmark';
  if (desired > 0) return 'stop';
  return copies > 0 ? 'wait' : 'pin';
}

export interface ReshapeIo {
  runningCopies: () => number;
  scale: (service: string, replicas: number) => Promise<unknown>;
  deploy: (spec: ServiceSpec) => Promise<unknown>;
  removeMark: (service: string) => Promise<unknown>;
}

/** One reshape step for the cluster's writer; returns what it did. */
export async function convergeReshape(w: SwarmServiceInfo | undefined, net: string, io: ReshapeIo): Promise<ReshapeStep> {
  if (!w) return 'none';
  const step = reshapeStep(w, io.runningCopies());
  if (step === 'stop') await io.scale(w.name, 0);
  else if (step === 'pin') await io.deploy(promotedCopySpec(w, w.labels[DB_FAILOVER_PROMOTING_LABEL]!, net));
  else if (step === 'unmark') await io.removeMark(w.name);
  return step;
}
