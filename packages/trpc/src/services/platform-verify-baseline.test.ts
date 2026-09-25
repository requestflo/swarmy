import { describe, expect, it } from 'bun:test';
import { unhealthySystemServices, verifyProblems } from './platform-upgrade.service';

/** QA-027: Verify fails on regressions, not on services that were already broken. */
const svc = (name: string, running: number, desired: number) => ({ name, runningReplicas: running, desiredReplicas: desired });

describe('upgrade verify baseline', () => {
  it('only swarmy system services under their desired count are unhealthy', () => {
    expect(
      unhealthySystemServices([svc('swarmy-dns', 0, 1), svc('shop_web', 0, 1), svc('swarmy-garage', 3, 3)]).map((s) => s.name),
    ).toEqual(['swarmy-dns']);
  });

  it('a service already broken at preflight is reported, not failed on', () => {
    const r = verifyProblems({ offlineNodes: [], services: [svc('swarmy-dns', 0, 1)], baseline: ['swarmy-dns'] });
    expect(r).toEqual({ problems: [], preexisting: ['swarmy-dns'] });
  });

  it('a regression (healthy before, broken after) fails', () => {
    const r = verifyProblems({ offlineNodes: [], services: [svc('swarmy-dns', 0, 1), svc('swarmy-garage', 1, 3)], baseline: ['swarmy-dns'] });
    expect(r.problems).toEqual(['swarmy-garage 1/3']);
  });

  it('an offline server always fails', () => {
    expect(verifyProblems({ offlineNodes: ['node-2'], services: [], baseline: [] }).problems).toEqual(['node-2 offline']);
  });
});
