import { describe, expect, it } from 'bun:test';
import { SCALE_TO_ZERO_LABEL, SCALE_TO_ZERO_TARGET_LABEL } from '@swarmy/core';
import { wakeToken } from '@swarmy/core/wake-token';
import { findWakeable, orgForWakeToken, type WakeStore } from './activator-auth';

const KEY = 's'.repeat(64);
const s2z = (target?: number) => ({
  [SCALE_TO_ZERO_LABEL]: 'true',
  ...(target ? { [SCALE_TO_ZERO_TARGET_LABEL]: String(target) } : {}),
});

/** Two orgs both run a sleeping `web`; org B also has `admin`, stopped at 0 by hand (not opted in). */
const STORE: WakeStore = {
  serviceInfo: new Map([
    ['node-a', [{ name: 'web', labels: s2z(2), runningReplicas: 0 }]],
    ['node-b', [{ name: 'web', labels: s2z(), runningReplicas: 0 }, { name: 'admin', labels: {}, runningReplicas: 0 }]],
  ]),
  nodeOrg: new Map([
    ['node-a', 'org_a'],
    ['node-b', 'org_b'],
  ]),
};

describe('activator: signed wake links', () => {
  it("resolves a token to the org it was signed for, even when another org uses the same name", () => {
    expect(orgForWakeToken(STORE, 'web', wakeToken('org_a', 'web', KEY), KEY)).toBe('org_a');
    expect(orgForWakeToken(STORE, 'web', wakeToken('org_b', 'web', KEY), KEY)).toBe('org_b');
  });

  it('wakes nothing for a forged, missing, cross-service or wrong-key token', () => {
    expect(orgForWakeToken(STORE, 'web', 'A'.repeat(22), KEY)).toBeUndefined();
    expect(orgForWakeToken(STORE, 'web', '', KEY)).toBeUndefined();
    expect(orgForWakeToken(STORE, 'web', wakeToken('org_a', 'api', KEY), KEY)).toBeUndefined();
    expect(orgForWakeToken(STORE, 'web', wakeToken('org_a', 'web', 'x'.repeat(64)), KEY)).toBeUndefined();
  });

  it('never wakes a service that did not opt into scale-to-zero, even with a valid token', () => {
    expect(orgForWakeToken(STORE, 'admin', wakeToken('org_b', 'admin', KEY), KEY)).toBeUndefined();
    expect(findWakeable(STORE, 'admin', 'org_b')).toBeUndefined();
  });

  it("reads the woken org's own target replicas", () => {
    expect(findWakeable(STORE, 'web', 'org_a')).toEqual({ orgId: 'org_a', running: 0, target: 2 });
    expect(findWakeable(STORE, 'web', 'org_b')).toEqual({ orgId: 'org_b', running: 0, target: 1 });
    expect(findWakeable(STORE, 'web', 'org_c')).toBeUndefined();
  });
});
