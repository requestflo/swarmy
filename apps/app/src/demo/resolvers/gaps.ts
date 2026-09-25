import type { AppRouter } from '@swarmy/trpc';
import type { DomainResolvers } from '../types';

/**
 * Queries no richer demo module covers yet. The generic fallback guesses a
 * shape from the procedure's name and can guess wrong (an object where the page
 * maps over an array), which crashes the route. These return the real output
 * types, checked against AppRouter, holding a quiet "nothing here yet" world.
 */
type Walk<T> = T extends { _def: { $types: { output: infer X } } }
  ? X
  : T extends object
    ? { [K in keyof T]: Walk<T[K]> }
    : never;
type Out = Walk<AppRouter['_def']['record']>;

const now = (): string => new Date().toISOString();
const inp = <T>(i: unknown): Partial<T> => (i ?? {}) as Partial<T>;

export const gaps: DomainResolvers = {
  handlers: {
    // Queue Studio (browse BullMQ jobs on a cache cluster): no live Redis in the demo.
    'queues.studioClusters': (): Out['queues']['studioClusters'] => [],
    'queues.studioOverview': (i): Out['queues']['studioOverview'] => {
      const { stack = '', cluster = '', prefix = 'bull' } = inp<{ stack: string; cluster: string; prefix: string }>(i);
      return { stack, cluster, prefix, purpose: 'queue', primary: `${cluster}-0`, queues: [], truncated: false, sampledAt: now() };
    },
    'queues.studioJobs': (): Out['queues']['studioJobs'] => ({ start: 0, state: 'wait', jobs: [], total: 0 }),
    'queues.studioJob': (): Out['queues']['studioJob'] => ({ found: false }),
    'queues.studioRates': (): Out['queues']['studioRates'] => ({ status: 'ok', points: [] }),

    // Error tracking: the project is live, no issues have come in.
    'errors.issues': (): Out['errors']['issues'] => ({ status: 'ok', issues: [] }),
    'errors.issue': (): Out['errors']['issue'] => ({
      status: 'ok',
      issue: null,
      event: null,
      events: [],
      tags: [],
      introducedIn: null,
    }),

    // Mesh people access and the managed control plane: not set up in the demo.
    'mesh.control.status': (): Out['mesh']['control']['status'] => ({
      managed: false,
      cluster: null,
      meshDomain: null,
      managementUrl: null,
      version: 'demo',
      node: { id: null, hostname: null, online: false },
      status: null,
      statusAt: null,
      identity: { connector: false, localLogin: false, breakGlass: false },
      backup: { configured: false, running: false, bucket: null },
      peers: { total: 0, servers: 0 },
      tls: null,
      warnings: [],
    }),
    'mesh.people.card': (): Out['mesh']['people']['card'] => ({
      managed: false,
      settings: { enabled: false, loginExpiryHours: 12 },
      online: 0,
      devices: 0,
      identity: 'swarmy',
      plan: null,
    }),
    'mesh.people.connected': (): Out['mesh']['people']['connected'] => [],
    'mesh.people.grants': (): Out['mesh']['people']['grants'] => [],
    'mesh.people.connectInfo': (): Out['mesh']['people']['connectInfo'] => ({
      available: false,
      reason: 'People access is off in this demo.',
      managementUrl: null,
      profile: null,
      commands: null,
      allowed: false,
      via: [],
      services: [],
      grantors: [],
      loginExpiryHours: 12,
    }),

    // Node retirement: a plan with nothing to move, and no run in progress.
    'decommission.plan': (i, store): Out['decommission']['plan'] => {
      const id = inp<{ nodeId: string }>(i).nodeId;
      const node = store.nodes.find((n) => n.id === id) ?? store.nodes[0];
      return {
        node: {
          nodeId: node?.id ?? '',
          hostname: node?.hostname ?? 'node',
          role: node?.role === 'manager' ? 'manager' : 'worker',
          online: node?.status === 'online',
        },
        steps: [],
        blockers: [],
        warnings: [],
        totals: { databases: 0, volumes: 0, statelessServices: 0, bytesToMove: 0, unknownSizes: 0 },
        summary: 'Nothing on this server needs moving first. In a real swarm, swarmy drains it and removes it.',
        runnable: true,
      };
    },
    'decommission.status': (i, store): Out['decommission']['status'] => {
      const id = inp<{ nodeId: string }>(i).nodeId ?? '';
      const node = store.nodes.find((n) => n.id === id);
      return {
        runId: 'demo',
        nodeId: id,
        hostname: node?.hostname ?? 'node',
        status: 'done',
        done: [],
        current: null,
        log: [],
        error: null,
        startedAt: now(),
        finishedAt: now(),
        startedBy: null,
      } as Out['decommission']['status'];
    },
    'decommission.oldCopies': (): Out['decommission']['oldCopies'] => [],

    // Per-region replicas: every service runs wherever the scheduler put it.
    'region.knownRegions': (_i, store): Out['region']['knownRegions'] => [
      ...new Set(store.nodes.map((n) => n.labels?.['swarmy.region']).filter((r): r is string => !!r)),
    ],
    'region.plan': (): Out['region']['plan'] => [],
    'region.get': (i, store): Out['region']['get'] => {
      const id = inp<{ serviceId: string }>(i).serviceId ?? '';
      const svc = store.services.find((s) => s.id === id || s.name === id);
      return {
        serviceId: svc?.id ?? id,
        serviceName: svc?.name ?? id,
        regions: [],
        knownRegions: [],
        desiredTotal: 0,
        liveDesired: svc?.replicas?.desired ?? 0,
      };
    },

    'services.inspect': (i, store): Out['services']['inspect'] => {
      const id = inp<{ id: string }>(i).id;
      const svc = store.services.find((s) => s.id === id);
      return svc ? { ID: svc.id, Spec: { Name: svc.name } } : {};
    },

    // `swarmy login` device approval: there's no CLI waiting on a demo.
    'apiKeys.cliRequest': (): Out['apiKeys']['cliRequest'] => {
      throw new Error('This is a demo: there is no CLI sign-in request to approve.');
    },
  },
};
