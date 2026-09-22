import { describe, expect, it } from 'bun:test';
import { explainReformFailure, hostOf, shouldRestartDockerFirst, stalePeers } from './rejoin-plan';

describe('stalePeers', () => {
  const dead = new Set(['100.71.150.60:2377']);
  const reachable = (a: string) => !dead.has(a);

  it('flags the dead preserved self-entry even though it carries our own node id', () => {
    const out = stalePeers(
      [{ NodeID: 'ypj9', Addr: '100.71.150.60:2377' }],
      { nodeId: 'ypj9', nodeAddr: '100.71.224.116' },
      reachable,
    );
    expect(out).toEqual(['100.71.150.60:2377']);
  });

  it('ignores our own current address and reachable peers', () => {
    const out = stalePeers(
      [
        { NodeID: 'a', Addr: '100.71.224.116:2377' },
        { NodeID: 'b', Addr: '10.0.0.5:2377' },
      ],
      { nodeId: 'a', nodeAddr: '100.71.224.116' },
      reachable,
    );
    expect(out).toEqual([]);
  });

  it('hostOf handles v4 and bracketed v6', () => {
    expect(hostOf('10.0.0.1:2377')).toBe('10.0.0.1');
    expect(hostOf('[fd00::1]:2377')).toBe('fd00::1');
    expect(hostOf('10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('explainReformFailure', () => {
  it('names the stale peer on a deadline and asks for a docker restart retry once', () => {
    const r = explainReformFailure({ timedOut: true, exitCode: null, stderr: '' }, ['100.71.150.60:2377'], false);
    expect(r.message).toContain('stale swarm peer');
    expect(r.message).toContain('100.71.150.60:2377');
    expect(r.retryAfterDockerRestart).toBe(true);
    expect(explainReformFailure({ timedOut: true, exitCode: null, stderr: '' }, ['x'], true).retryAfterDockerRestart).toBe(false);
  });

  it('recognises dockerd\'s own "context deadline exceeded"', () => {
    const r = explainReformFailure({ timedOut: false, exitCode: 1, stderr: 'Error: context deadline exceeded' }, [], false);
    expect(r.message).toContain('wedged');
    expect(r.retryAfterDockerRestart).toBe(true);
  });

  it('does not retry unrelated failures', () => {
    const r = explainReformFailure({ timedOut: false, exitCode: 1, stderr: 'invalid advertise address' }, [], false);
    expect(r.retryAfterDockerRestart).toBe(false);
    expect(r.message).toContain('invalid advertise address');
  });
});

describe('shouldRestartDockerFirst', () => {
  it('restarts when wedged or stale peers exist', () => {
    expect(shouldRestartDockerFirst({ controlPlaneResponsive: false, stale: [] })).toBe(true);
    expect(shouldRestartDockerFirst({ controlPlaneResponsive: true, stale: ['a'] })).toBe(true);
    expect(shouldRestartDockerFirst({ controlPlaneResponsive: true, stale: [] })).toBe(false);
  });
});
