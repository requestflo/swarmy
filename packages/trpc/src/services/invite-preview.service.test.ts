import { describe, expect, it } from 'bun:test';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { simulateInvitePolicy } from './invite-preview.service';

function svc(name: string, stack: string, labels: Record<string, string> = {}): SwarmServiceInfo {
  return {
    id: `id_${name}`,
    name,
    image: 'web:1',
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 0,
    updatedAt: 0,
    labels: { 'com.docker.stack.namespace': stack, ...labels },
    networks: [],
    env: [],
    ports: [],
    secrets: [],
    configs: [],
  } as SwarmServiceInfo;
}

const SERVICES = [
  svc('shop_web', 'shop'),
  svc('pay_api', 'pay', { 'swarmy.env': 'production' }),
  svc('swarmy-system_api', 'swarmy-system', { 'swarmy.env': 'production' }),
];

/** No nodes → the swarm-kv config rows read empty, so apps are the live (label-only) stacks. */
function ctx(policies: unknown[] = []): OrgContext {
  return {
    db: {
      node: { count: async () => 0 },
      policy: { findMany: async () => policies },
    },
    hub: { liveInventory: () => ({ services: SERVICES, containers: [] }) },
    activeOrgId: 'org1',
    user: { id: 'u1' },
    membership: { role: 'admin', orgId: 'org1' },
    reqHeaders: new Headers(),
  } as unknown as OrgContext;
}

describe('policies.simulateInvite — the invitee judged by the org\'s real rules over its real apps', () => {
  it('reads production from live labels and leaves the platform stack out', async () => {
    const r = await simulateInvitePolicy(ctx(), { role: 'member' });
    expect(r.appCount).toBe(2);
    const deploy = r.verdicts.find((v) => v.key === 'deploy')!;
    expect(deploy).toMatchObject({ reach: 'some', allowedOn: ['shop'], deniedOn: ['pay'] });
  });

  it('an app-scoped member gets operator on that app (a production deploy is then allowed)', async () => {
    const r = await simulateInvitePolicy(ctx(), { role: 'member', stackNames: ['pay', 'pay', ' '] });
    expect(r.stackNames).toEqual(['pay']);
    expect(r.verdicts.find((v) => v.key === 'deploy')).toMatchObject({ reach: 'all', deniedOn: [] });
    expect(r.verdicts.find((v) => v.key === 'shell')!.reach).toBe('none');
  });

  it('owners and admins ignore the app list', async () => {
    const r = await simulateInvitePolicy(ctx(), { role: 'admin', stackNames: ['shop'] });
    expect(r.stackNames).toEqual([]);
    expect(r.verdicts.every((v) => v.reach === 'all')).toBe(true);
  });

  it('a stored forbid rule shows up as "blocked by policy"', async () => {
    const forbid = {
      id: 'pol-x',
      name: 'Nobody opens shells',
      effect: 'forbid',
      source: JSON.stringify({ actions: ['terminal.open'] }),
      priority: 10,
      enabled: true,
      isDefault: false,
    };
    const r = await simulateInvitePolicy(ctx([forbid]), { role: 'owner' });
    expect(r.verdicts.find((v) => v.key === 'shell')).toMatchObject({ reach: 'none', blockedBy: { id: 'pol-x', name: 'Nobody opens shells' } });
  });
});
