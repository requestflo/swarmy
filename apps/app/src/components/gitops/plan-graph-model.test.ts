import { describe, expect, test } from 'bun:test';
import type { PlanActionView } from './gitops-types';
import { diffCounts, planGraph, shortName } from './plan-graph-model';

const a = (o: Partial<PlanActionView> & Pick<PlanActionView, 'id' | 'kind'>): PlanActionView => ({
  phase: 1,
  gate: 'auto',
  reason: '',
  ...o,
});

describe('planGraph', () => {
  test('lays each action on its column with its diff, and ghosts untouched services', () => {
    const g = planGraph(
      [
        a({ id: 'build:web', kind: 'build', services: ['web'] }),
        a({ id: 'service.deploy:web', kind: 'service.deploy', name: 'web', op: 'update', image: { fromBuild: 'web' } }),
        a({ id: 'service.deploy:worker', kind: 'service.deploy', name: 'worker', op: 'create', image: { image: 'w:1' } }),
        a({ id: 'route.add:docs', kind: 'route.add', host: 'docs.example.com', path: '/' }),
        a({ id: 'resource.create:sessions', kind: 'resource.create', name: 'sessions', resource: { type: 'cache' } }),
        a({ id: 'resource.delete:search', kind: 'resource.delete', name: 'search', resourceType: 'search', gate: 'confirm' }),
        a({ id: 'link.add:billing', kind: 'link.add', peer: 'billing' }),
      ],
      ['web', 'api'],
    );
    expect(g.front).toEqual([{ key: 'route.add:docs', label: 'docs.example.com', meta: 'address', diff: 'add', gate: undefined }]);
    expect(g.services.map((n) => [n.label, n.diff, n.meta])).toEqual([
      ['web', 'change', 'built from source'],
      ['worker', 'add', 'w:1'],
      ['api', 'same', undefined],
    ]);
    expect(g.data.map((n) => [n.label, n.diff, n.meta, n.gate])).toEqual([
      ['sessions', 'add', 'cache', undefined],
      ['search', 'remove', 'search', 'confirm'],
      ['billing', 'add', 'connected app', undefined],
    ]);
    expect(diffCounts(g)).toBe('4 to add · 1 to change · 1 to remove');
  });

  test('a rollout without op reads as a change; Docker names are shortened', () => {
    const g = planGraph([a({ id: 'service.deploy:web', kind: 'service.deploy', name: 'web' })], []);
    expect(g.services[0]!.diff).toBe('change');
    expect(shortName('storefront', 'storefront_web')).toBe('web');
    expect(shortName('storefront', 'web')).toBe('web');
  });
});
