import type { DomainResolvers } from '../types';

/**
 * Controller store demo (resilience P3): a replicated controller on mgr-1,
 * streaming control.db to Garage, with two other managers to move to. Mirrors
 * ControllerStoreView (controllerStore.service.ts).
 */
function view() {
  return {
    role: 'leader' as const,
    hostname: 'mgr-1',
    swarmNodeId: 'n-mgr-1',
    epoch: 7,
    leaseRenewedAgoSec: 4,
    waitingFor: null,
    mode: 'replicated' as const,
    target: { kind: 'garage' as const, label: 'Garage (in-swarm)', endpoint: 'http://swarmy-garage:3900', bucket: 'swarmy-control', prefix: 'control' },
    replicating: true,
    lastReplicatedAt: new Date(Date.now() - 1_000).toISOString(),
    lagSeconds: 0,
    pendingBytes: 0,
    problem: null,
    bundleFallback: true,
    boot: { at: new Date(Date.now() - 86_400_000).toISOString(), kind: 'keep-local', outcome: 'kept the local file', reason: 'local file is the replica’s current lineage', durationMs: 180 },
    lossWindow: 'about 1 second of writes (Litestream ships every second); none on a clean move',
    managers: [
      { swarmNodeId: 'n-mgr-1', hostname: 'mgr-1', status: 'ready', availability: 'active', current: true, blocked: 'runs the controller now' },
      { swarmNodeId: 'n-mgr-2', hostname: 'mgr-2', status: 'ready', availability: 'active', current: false, blocked: null },
      { swarmNodeId: 'n-mgr-3', hostname: 'mgr-3', status: 'ready', availability: 'active', current: false, blocked: null },
    ],
  };
}

export const controllerstore: DomainResolvers = {
  handlers: {
    'controllerStore.status': () => view(),
    'controllerStore.enableReplication': () => ({ restarting: true, secret: 'swarmy_control_store.demo', target: 'Garage (in-swarm)' }),
    'controllerStore.disableReplication': () => ({ restarting: true, pinnedTo: 'mgr-1' }),
    'controllerStore.move': (i) => ({ from: 'mgr-1', to: (i as { swarmNodeId: string }).swarmNodeId.replace(/^n-/, ''), restarting: true }),
  },
};
