/**
 * Wires the controller store into the controller process: the hub supplies
 * manager agents for the lease, Prisma supplies the PRAGMA channel, and
 * startWorkers runs only once we are the writer.
 */
import type { ControllerServiceResult } from '@swarmy/core/protocol';
import { prisma } from '@swarmy/db';
import { setControllerStoreRuntime } from '@swarmy/trpc';
import { hub, registry, store } from '../gateway';
import { controllerIdentity } from './config';
import { ControllerStore } from './supervisor';

/** Online manager agents; the one on our own node first (its raft view is ours). */
export function leaseManagers(ownHostname: string): string[] {
  const online = registry.onlineNodeIds().filter((id) => store.managers.get(id) === true);
  return online.sort((a, b) => Number(store.nodeHostname.get(b) === ownHostname) - Number(store.nodeHostname.get(a) === ownHostname));
}

/**
 * Manager nodes in the swarm (online or not), from the node lists the manager
 * agents report; null until one has reported. PURE over those lists.
 */
export function swarmManagerCount(lists: Iterable<ReadonlyArray<{ swarmNodeId: string; role: string }>>): number | null {
  const ids = new Set<string>();
  let seen = false;
  for (const list of lists) {
    seen = true;
    for (const n of list) if (n.role === 'manager') ids.add(n.swarmNodeId);
  }
  return seen && ids.size > 0 ? ids.size : null;
}

export function startControllerStore(startWorkers: () => () => void): ControllerStore {
  const self = controllerIdentity();
  const cs = new ControllerStore({
    managers: () => leaseManagers(self.hostname),
    managerCount: () => swarmManagerCount([...store.swarmNodes.values(), ...store.lastKnownSwarmNodes.values()]),
    dispatch: (nodeId, payload, timeoutMs) =>
      hub.dispatch<ControllerServiceResult>(nodeId, 'controller.service', payload, { timeoutMs }),
    pragma: async (sql) => {
      await prisma.$executeRawUnsafe(sql);
    },
    onLeader: startWorkers,
    // eslint-disable-next-line no-console
    log: (m) => console.log(m),
    exit: (code) => process.exit(code),
  });
  setControllerStoreRuntime(cs);
  cs.start();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => void cs.shutdown(0));
  }
  return cs;
}
