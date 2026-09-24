import { describe, expect, test } from 'bun:test';
import { liveStacks, peopleSettings } from './mesh-people.service';

const svc = (name: string, labels: Record<string, string>, networks: string[]) =>
  ({ id: name, name, image: 'x', mode: 'replicated', runningReplicas: 1, createdAt: 0, updatedAt: 0, labels, networks: networks.map((n) => ({ name: n, aliases: [] })), env: [], ports: [], secrets: [], configs: [] }) as never;

describe('people access settings', () => {
  test('off by default, 12 h expiry (owner picks, plan §9.3)', () => {
    expect(peopleSettings({})).toEqual({ enabled: false, loginExpiryHours: 12 });
    expect(peopleSettings({ peopleAccess: { enabled: true, loginExpiryHours: 8 } })).toEqual({ enabled: true, loginExpiryHours: 8 });
    expect(peopleSettings({ peopleAccess: { enabled: 'yes', loginExpiryHours: -1 } })).toEqual({ enabled: false, loginExpiryHours: 12 });
  });
});

describe('liveStacks', () => {
  test('groups by stack, picks the stack overlay for the router, skips system stacks', () => {
    const stacks = liveStacks([
      svc('shop_db', { 'com.docker.stack.namespace': 'shop' }, ['shop_default', 'swarmy']),
      svc('shop_web', { 'com.docker.stack.namespace': 'shop' }, ['shop_default', 'shop_front']),
      svc('blog_app', { 'com.docker.stack.namespace': 'blog' }, ['blog_backend']),
      svc('swarmy_controller', { 'com.docker.stack.namespace': 'swarmy' }, ['swarmy-control']),
      svc('garage', { 'com.docker.stack.namespace': 'store', 'swarmy.system': 'true' }, ['swarmy']),
      svc('loose', {}, ['bridge']),
    ]);
    expect(stacks.map((s) => [s.name, s.network, s.services.map((x) => x.name)])).toEqual([
      ['blog', 'blog_backend', ['blog_app']],
      ['shop', 'shop_default', ['shop_db', 'shop_web']],
    ]);
  });
  test('a stack with only shared networks gets no router network (never swarmy / swarmy-control)', () => {
    expect(liveStacks([svc('x_a', { 'com.docker.stack.namespace': 'x' }, ['swarmy', 'swarmy-control'])])[0]!.network).toBeNull();
  });
});
