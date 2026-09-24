import { describe, expect, test } from 'bun:test';
import { filterCatalog, localRepoOf, registryBaseCandidates, sortLocalTags } from './images-local';
import { mergeImageSuggestions, type ImageSuggestion } from './images.service';

describe('registryBaseCandidates', () => {
  test('override first, then each ready node via the routing mesh, deduped', () => {
    expect(
      registryBaseCandidates({
        override: 'http://10.0.0.9:5000/',
        nodes: [
          { addr: '10.0.0.2', status: 'ready' },
          { addr: '10.0.0.3', status: 'down' },
          { addr: '10.0.0.2', status: 'ready' },
          { addr: '0.0.0.0', status: 'ready' },
          { addr: 'fd00::4', status: 'ready' },
          { status: 'ready' },
        ],
        registryHost: 'localhost:5000',
      }),
    ).toEqual(['http://10.0.0.9:5000', 'http://10.0.0.2:5000', 'http://[fd00::4]:5000']);
  });

  test('a custom non-loopback host is tried last over TLS; legacy/loopback never', () => {
    expect(registryBaseCandidates({ override: undefined, nodes: [], registryHost: 'registry.example.com' })).toEqual([
      'https://registry.example.com',
    ]);
    expect(registryBaseCandidates({ override: undefined, nodes: [], registryHost: 'swarmy-registry:5000' })).toEqual([]);
    expect(registryBaseCandidates({ override: undefined, nodes: [], registryHost: '127.0.0.1:5000' })).toEqual([]);
  });
});

describe('filterCatalog', () => {
  const repos = ['acme/api', 'acme/web', 'web', 'tools/webhook-relay', 'other/db'];
  test('matches substrings, exact leaf then prefix first, as canonical pull names', () => {
    expect(filterCatalog(repos, 'web', 'localhost:5000')).toEqual([
      'localhost:5000/acme/web',
      'localhost:5000/web',
      'localhost:5000/tools/webhook-relay',
    ]);
  });
  test('empty query → nothing; limit applies', () => {
    expect(filterCatalog(repos, '  ', 'localhost:5000')).toEqual([]);
    expect(filterCatalog(repos, 'a', 'h', 2)).toHaveLength(2);
  });
});

describe('localRepoOf', () => {
  test('recognises the org host, canonical and legacy hosts; strips tag + digest', () => {
    expect(localRepoOf('localhost:5000/acme/web:v1', 'localhost:5000')).toBe('acme/web');
    expect(localRepoOf('swarmy-registry:5000/acme/web@sha256:abc', 'localhost:5000')).toBe('acme/web');
    expect(localRepoOf('reg.example.com/team/app', 'reg.example.com')).toBe('team/app');
  });
  test('Hub and other registries → null', () => {
    expect(localRepoOf('nginx:1.27', 'localhost:5000')).toBeNull();
    expect(localRepoOf('ghcr.io/x/y', 'localhost:5000')).toBeNull();
  });
});

test('sortLocalTags: latest first, then descending natural order', () => {
  expect(sortLocalTags(['v1.2', 'v1.10', 'latest', 'v1.9'])).toEqual(['latest', 'v1.10', 'v1.9', 'v1.2']);
});

describe('mergeImageSuggestions', () => {
  const hub: ImageSuggestion[] = [
    { name: 'nginx', source: 'hub', description: '', official: true, stars: 1 },
    { name: 'localhost:5000/acme/web', source: 'hub', description: '', official: false, stars: 0 },
  ];
  test('local first, hub second, hub duplicates of a local name dropped', () => {
    const out = mergeImageSuggestions(['localhost:5000/acme/web'], hub);
    expect(out.map((s) => [s.source, s.name])).toEqual([
      ['local', 'localhost:5000/acme/web'],
      ['hub', 'nginx'],
    ]);
  });
  test('hub unreachable (null) → local only; registry off (null) → hub only', () => {
    expect(mergeImageSuggestions(['localhost:5000/a'], null).map((s) => s.source)).toEqual(['local']);
    expect(mergeImageSuggestions(null, hub).every((s) => s.source === 'hub')).toBe(true);
  });
});
