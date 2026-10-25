import type { AppRouter } from '@swarmy/trpc';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Mesh access rules (`mesh.rules.*`, mirror of `MeshAccessRulesView` in
 * mesh-rules.service.ts) for Mesh settings: swarmy's own two (servers reach
 * each other; people allowed on storefront reach its Postgres) and two of the
 * team's (Servers → Databases on 5432; Office → Servers on 22, switched off).
 * Add and remove change the list, like the real NetBird would.
 */
type Walk<T> = T extends { _def: { $types: { output: infer X } } } ? X : T extends object ? { [K in keyof T]: Walk<T[K]> } : never;
type View = Walk<AppRouter['_def']['record']>['mesh']['rules']['list'];
type Rule = View['rules'][number];

const GROUPS = ['Databases', 'Office', 'Servers'];
const base = { toResource: false, bidirectional: false, action: 'accept' as const, enabled: true, managedBySwarmy: false, simple: true };

function seedRules(): Rule[] {
  return [
    { ...base, id: 'pol-nodes', name: 'swarmy-demo-nodes', from: ['swarmy:demo:nodes'], to: ['swarmy:demo:nodes'], protocol: 'all', ports: [], bidirectional: true, managedBySwarmy: true, words: 'Servers can reach each other on every port' },
    { ...base, id: 'pol-store-db', name: 'swarmy-demo-s-store-db', from: ['swarmy:demo:access:s-store'], to: [], toResource: true, protocol: 'tcp', ports: ['5432'], managedBySwarmy: true, simple: false, words: "People allowed on storefront can reach storefront's db on 5432" },
    { ...base, id: 'pol-srv-db', name: 'Servers → Databases tcp/5432', from: ['Servers'], to: ['Databases'], protocol: 'tcp', ports: ['5432'], words: 'Servers can reach Databases on 5432' },
    { ...base, id: 'pol-office-ssh', name: 'Office SSH', from: ['Office'], to: ['Servers'], protocol: 'tcp', ports: ['22'], enabled: false, words: 'Office can reach Servers on 22 (switched off)' },
  ];
}

const rules = (store: DemoStore): Rule[] => store.extra.meshRules as Rule[];
const view = (store: DemoStore): View => ({ supported: true, note: null, rules: rules(store), groups: GROUPS, error: null });

function wordsFor(from: string, to: string, protocol: string, ports: number[]): string {
  if (protocol === 'all') return `${from} can reach ${to} on every port`;
  const list = ports.length > 1 ? `${ports.slice(0, -1).join(', ')} and ${ports[ports.length - 1]}` : String(ports[0] ?? '');
  if (!ports.length) return `${from} can reach ${to} on every ${protocol.toUpperCase()} port`;
  return `${from} can reach ${to} on ${protocol === 'udp' ? 'UDP ' : ''}${list}`;
}

export const meshRules: DomainResolvers = {
  seed: (store) => {
    store.extra.meshRules = seedRules();
  },
  handlers: {
    'mesh.rules.list': (_i, store): View => view(store),
    'mesh.rules.add': (i, store): View => {
      const { from, to, protocol = 'tcp', ports = [] } = i as { from: string; to: string; protocol?: 'tcp' | 'udp' | 'all'; ports?: number[] };
      const ps = [...new Set(ports)].sort((a, b) => a - b);
      const name = `${from} → ${to}${protocol === 'all' ? '' : ps.length ? ` ${protocol}/${ps.join(',')}` : ` ${protocol}`}`;
      if (rules(store).some((r) => r.name === name)) throw new Error(`that rule already exists (${name})`);
      rules(store).push({ ...base, id: `pol-${Date.now()}`, name, from: [from], to: [to], protocol, ports: ps.map(String), words: wordsFor(from, to, protocol, ps) });
      return view(store);
    },
    'mesh.rules.remove': (i, store): View => {
      const { id } = i as { id: string };
      const r = rules(store).find((x) => x.id === id);
      if (r?.managedBySwarmy) throw new Error(`${r.name} is swarmy's own rule: it follows the servers and people access, so it can't be removed here`);
      store.extra.meshRules = rules(store).filter((x) => x.id !== id);
      return view(store);
    },
  },
};
