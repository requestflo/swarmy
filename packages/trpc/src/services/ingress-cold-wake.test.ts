import { describe, expect, it } from 'bun:test';
import { SCALE_TO_ZERO_LABEL } from '@swarmy/core';
import { SwarmServiceInfo } from '@swarmy/core/protocol';
import { verifyWakeToken } from '@swarmy/core/wake-token';
import type { OrgContext } from '../context';
import { computeColdRoutes } from './ingress.service';

const svc = (name: string, running: number, s2z: boolean) =>
  SwarmServiceInfo.parse({
    id: `id-${name}`,
    name,
    image: 'nginx:1.27',
    mode: 'replicated',
    desiredReplicas: running,
    runningReplicas: running,
    createdAt: 0,
    updatedAt: 0,
    labels: s2z ? { [SCALE_TO_ZERO_LABEL]: 'true' } : {},
  });

const ctx = (orgId: string) =>
  ({
    activeOrgId: orgId,
    hub: { liveInventory: () => ({ services: [svc('web', 0, true), svc('api', 1, true), svc('ops', 0, false)], containers: [] }) },
  }) as unknown as Pick<OrgContext, 'activeOrgId' | 'hub'>;

describe('cold routes carry a signed wake path', () => {
  it('only asleep scale-to-zero services, each with an org-signed /_wake/<svc>/<token>', () => {
    const cold = computeColdRoutes(ctx('org_a'));
    expect([...cold.keys()]).toEqual(['web']);
    const m = /^\/_wake\/web\/([A-Za-z0-9_-]+)$/.exec(cold.get('web')!.wakePath);
    expect(m).not.toBeNull();
    expect(verifyWakeToken('org_a', 'web', m![1]!)).toBe(true);
    // The same service name in another org renders a different token.
    expect(verifyWakeToken('org_b', 'web', m![1]!)).toBe(false);
    expect(computeColdRoutes(ctx('org_b')).get('web')!.wakePath).not.toBe(cold.get('web')!.wakePath);
  });
});
