import type { FirstLookInput, FirstLookView } from '@swarmy/core';
import type { DomainResolvers } from '../types';
import { ingress } from './ingress';

interface DemoRoute {
  host: string;
  tls: string;
  auto: boolean;
  status?: { certificate?: { expiresAt: string | null } | null } | null;
}

const hash = (x: string): number => [...x].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const DAY = 86_400_000;

/**
 * The demo's `deploys.firstLook`: believable numbers from the demo world —
 * copies from the app's services, HTTPS from its route's certificate, a
 * first response of 70–150 ms (stable per app) once its main service runs.
 */
export const firstLook: DomainResolvers = {
  handlers: {
    'deploys.firstLook': (i, s): FirstLookView => {
      const { stack, host } = i as FirstLookInput;
      const st = s.stacks.find((x) => x.name === stack);
      if (!st) throw new Error(`stack "${stack}" not found`);
      const own = s.services.filter((x) => x.stackId === st.id);
      const routes = ingress.handlers!['ingress.listDomains']!({ stack }, s) as DemoRoute[];
      const route = host ? routes.find((r) => r.host === host) : (routes.find((r) => r.tls !== 'off' && !r.auto) ?? routes.find((r) => r.tls !== 'off'));
      if (host && !route) throw new Error(`${host} isn't one of ${stack}'s addresses. swarmy only checks an app's own addresses.`);
      const copies = {
        running: own.reduce((n, x) => n + Math.min(x.replicas.running, x.replicas.desired), 0),
        desired: own.reduce((n, x) => n + x.replicas.desired, 0),
      };
      const base = { stack, host: route?.host ?? null, checkedAt: new Date().toISOString(), copies };
      if (!route) return { ...base, response: null, https: null };
      const up = own.some((x) => x.status === 'running');
      const exp = route.status?.certificate?.expiresAt ?? new Date(Date.now() + 89 * DAY).toISOString();
      return {
        ...base,
        response: up ? { ok: true, ms: 70 + (hash(stack) % 80), status: 200 } : { ok: false, error: 'it isn’t answering yet' },
        https: { valid: true, validUntil: exp, source: 'edge-check', error: null },
      };
    },
  },
};
