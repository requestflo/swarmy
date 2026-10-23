import { linkNetworkName, linkPair, type AuditEntryView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { demoEndpoints, demoServices, type LinksState } from './stack-endpoints';

/**
 * "Connect apps" demo resolvers — the Network › Connections tab
 * (`stacks.endpoints` / `connect` / `disconnect`) and the Postgres attach on
 * it (`db.inject`). The story: platform's Grafana and Prometheus reach
 * storefront's api over the pair's private network (connected), data is not
 * connected to anything, and storefront's checkout database is wired into
 * api and checkout only. Connect / disconnect write the same audit rows the
 * controller does (`stack.link.add` / `stack.link.remove`).
 */

const state = (store: DemoStore): LinksState => store.extra.stackLinks as LinksState;

function audit(store: DemoStore, action: string, a: string, b: string, services: string[]): void {
  const log = store.extra.auditlog as { entries: AuditEntryView[] } | undefined;
  if (!log) return;
  const id = String(Math.max(0, ...log.entries.map((e) => Number(e.id))) + 1);
  log.entries.unshift({
    id,
    ts: new Date().toISOString(),
    actorType: 'user',
    actorId: store.user.id,
    actorLabel: store.user.name,
    action,
    targetType: 'stack',
    targetId: `${a}<->${b}`,
    metadata: { stacks: [a, b], network: linkNetworkName(store.org.id, a, b), services },
  });
}

function link(store: DemoStore, input: unknown, on: boolean) {
  const { stack, peer } = input as { stack: string; peer: string };
  const [a, b] = linkPair(stack.trim(), peer.trim());
  if (!a || !b || a === b) throw new Error(`pick two different apps to ${on ? 'connect' : 'disconnect'}`);
  for (const s of [a, b]) {
    if (s === 'swarmy-system') throw new Error(`"${s}" is a platform stack and can't be connected`);
    if (on && demoServices(store, s).length === 0) throw new Error(`stack "${s}" not found`);
  }
  const st = state(store);
  const key = `${a}<->${b}`;
  const was = st.pairs.includes(key);
  st.pairs = on ? [...new Set([...st.pairs, key])].sort() : st.pairs.filter((p) => p !== key);
  const services = was === on ? [] : [...demoServices(store, a), ...demoServices(store, b)].map((s) => s.full);
  audit(store, on ? 'stack.link.add' : 'stack.link.remove', a, b, services);
  return { stack, peer, network: linkNetworkName(store.org.id, a, b), services };
}

export const stackLinks: DomainResolvers = {
  seed: (store) => {
    store.extra.stackLinks = {
      pairs: ['platform<->storefront'],
      dbAttached: {
        'storefront/checkout': ['storefront_api', 'storefront_checkout'],
        'data/main': ['data_worker'],
        'platform/metrics': ['platform_grafana'],
      },
    } satisfies LinksState;
  },

  handlers: {
    'stacks.endpoints': (i, s) => demoEndpoints(s, state(s), (i as { stack: string }).stack),
    'stacks.connect': (i, s) => link(s, i, true),
    'stacks.disconnect': (i, s) => link(s, i, false),
    'db.inject': (i, s) => {
      const { stack, appService, cluster, envVar = 'DATABASE_URL' } = i as {
        stack: string;
        appService: string;
        cluster: string;
        envVar?: string;
      };
      const st = state(s);
      const k = `${stack}/${cluster}`;
      st.dbAttached[k] = [...new Set([...(st.dbAttached[k] ?? []), appService])].sort();
      const ro = envVar.endsWith('_URL') ? `${envVar.slice(0, -4)}_RO_URL` : `${envVar}_RO`;
      const url = (host: string): string => `postgres://postgres:****@${host}:5432/app`;
      return { appService, cluster, envVar, roVar: ro, rwUrl: url(`${k.replace('/', '_')}-primary`), roUrl: url(`${k.replace('/', '_')}-replica`) };
    },
  },
};
