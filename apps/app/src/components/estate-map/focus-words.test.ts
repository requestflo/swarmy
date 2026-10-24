import { describe, expect, test } from 'bun:test';
import type { NodeSummary, ServiceSummary } from '@swarmy/core';
import type { ServerView } from './estate-model';
import { movableServices, serverStory } from './focus-words';

const view = (node: Partial<NodeSummary>, over: Partial<ServerView> = {}): ServerView =>
  ({
    node: { id: 'n1', name: 'wkr-1', role: 'worker', status: 'online', ...node } as NodeSummary,
    roles: 'worker',
    size: '',
    busy: { pct: 34, which: 'CPU' },
    apps: [],
    note: null,
    mesh: { state: 'off', ip: null },
    cost: null,
    ...over,
  }) as ServerView;

const row = (app: string) => ({ app, parts: 'web', tone: 'ok' as const, word: null });

describe('serverStory', () => {
  test('roles, apps and the measured load, in one breath', () => {
    expect(serverStory(view({ role: 'manager', ingress: true }, { apps: [row('storefront'), row('blog')] }))).toBe(
      'It runs swarmy and is a front door for visitors. Runs storefront and blog. CPU is 34% busy, plenty of headroom.',
    );
  });
  test('no live numbers is said, not guessed; a private-only server says how it is reached', () => {
    expect(serverStory(view({ status: 'offline' }, { busy: null, note: 'private network only' }))).toBe(
      'It runs apps. Nothing of yours runs here. No live numbers right now. It has no public address, so it is reached over the private network. Status: offline.',
    );
  });
});

describe('movableServices', () => {
  test('only your apps’ services, by inventory stack first', () => {
    const svc = (id: string, stackId: string | null) => ({ id, name: id, stackId }) as ServiceSummary;
    const out = movableServices([svc('a', 'storefront'), svc('b', null), svc('c', 'swarmy-system')], new Set(['storefront', 'blog']), new Map([['b', 'blog']]));
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
