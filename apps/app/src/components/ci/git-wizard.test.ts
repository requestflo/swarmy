import { describe, expect, test } from 'bun:test';
import { defaultFolder, folderTree, isMonorepo } from './git-folder-tree';
import { parseManifest } from './git-manifest';
import { connectionsFor, initialProvider, providerChip, providerOf } from './git-providers';
import type { GitConnection } from './git-types';

const conn = (id: string, kind: GitConnection['kind'], baseUrl: string, account: string | null, status = 'active'): GitConnection => ({
  id,
  kind,
  baseUrl,
  account,
  status,
  displayName: account ?? baseUrl,
  repoCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
});

describe('git providers', () => {
  const conns = [
    conn('a', 'github', 'https://github.com', 'northwind'),
    conn('b', 'github', 'https://github.northwind.dev/', 'platform'),
    conn('c', 'gitlab', 'https://gitlab.com', 'dana.ops', 'pending'),
    conn('d', 'generic', 'https://git.example.com', null),
    conn('e', 'gitea', 'https://codeberg.org', 'dana'),
  ];

  test('cards by host: github.com, gitlab.com, Gitea/Forgejo its own, other hosts self-hosted, generic = any URL', () => {
    expect(conns.map(providerOf)).toEqual(['github', 'self', 'gitlab', 'url', 'gitea']);
    expect(providerChip('gitea', conns)).toEqual({ label: 'connected · dana', tone: 'ok' });
  });

  test('only active connections back a card', () => {
    expect(connectionsFor('gitlab', conns)).toEqual([]);
    expect(providerChip('gitlab', conns)).toEqual({ label: 'not connected', tone: 'idle' });
    expect(providerChip('github', conns)).toEqual({ label: 'connected · northwind', tone: 'ok' });
    expect(providerChip('self', [])).toEqual({ label: 'one-click app', tone: 'mesh' });
  });

  test('opens on the connection just made, else the first connected card', () => {
    expect(initialProvider(conns, 'b')).toBe('self');
    expect(initialProvider(conns)).toBe('github');
    expect(initialProvider([])).toBe('github');
  });
});

describe('folder tree', () => {
  const tree = [
    'package.json',
    'services/orders/Dockerfile',
    'services/orders/package.json',
    'services/payments/swarmy.yaml',
    'services/payments/Dockerfile',
    'packages/ui/package.json',
    'tools/go.mod',
  ];
  const rows = folderTree(tree);

  test('parents become headings, folders carry what their file names say', () => {
    expect(rows.map((r) => [r.dir, r.depth, r.pickable, r.tags.join(',')])).toEqual([
      ['', 0, true, 'Node'],
      ['packages', 0, false, ''],
      ['packages/ui', 1, true, 'Node'],
      ['services', 0, false, ''],
      ['services/orders', 1, true, 'Dockerfile,Node'],
      ['services/payments', 1, true, 'swarmy.yaml,Dockerfile'],
      ['tools', 0, true, 'Go'],
    ]);
    expect(rows.find((r) => r.dir === 'services/orders')?.configPath).toBe('services/orders/swarmy.yaml');
  });

  test('monorepo when more than one folder below the root holds an app', () => {
    expect(isMonorepo(rows)).toBe(true);
    expect(isMonorepo(folderTree(['swarmy.yaml', 'Dockerfile']))).toBe(false);
  });

  test('starts on a swarmy.yaml that is not an app yet, then a Dockerfile', () => {
    expect(defaultFolder(rows)?.dir).toBe('services/payments');
    expect(defaultFolder(rows, ['services/payments/swarmy.yaml'])?.dir).toBe('services/orders');
    expect(defaultFolder(folderTree(['swarmy.yml']))?.configPath).toBe('swarmy.yml');
  });
});

describe('manifest preview', () => {
  test('reads the manifest the controller built', () => {
    const json = JSON.stringify({
      name: 'swarmy-swarmy-northwind-dev',
      hook_attributes: { url: 'https://swarmy.northwind.dev/webhooks/github', active: true },
      public: false,
      default_permissions: { contents: 'read', checks: 'write' },
      default_events: ['push', 'pull_request'],
    });
    expect(parseManifest(json)).toEqual({
      name: 'swarmy-swarmy-northwind-dev',
      webhook: 'https://swarmy.northwind.dev/webhooks/github',
      permissions: ['contents:read', 'checks:write'],
      events: ['push', 'pull_request'],
      public: false,
    });
  });

  test('anything else is no preview, not a guess', () => {
    expect(parseManifest('{}')).toBeNull();
    expect(parseManifest('not json')).toBeNull();
  });
});
