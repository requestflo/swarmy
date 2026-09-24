import { describe, expect, test } from 'bun:test';
import type { DeployStatus } from '@swarmy/core/views';
import { withDeployProgress } from './deployment.service';

const live: DeployStatus = {
  deploymentId: 'svc1',
  serviceId: 'svc1',
  kind: 'deploy',
  phase: 'complete',
  desired: 1,
  ready: 1,
  message: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:00.000Z',
};

describe('withDeployProgress', () => {
  test('no progress leaves the synthesized status alone', () => {
    expect(withDeployProgress(live, undefined, 'svc1')).toBe(live);
    expect(withDeployProgress(null, undefined, 'web')).toBeNull();
  });

  test('an in-flight pull overrides "complete" with pulling + the agent message', () => {
    const s = withDeployProgress(live, { phase: 'pulling', message: 'pulling image big:1…', startedAt: 0, at: 5 }, 'svc1');
    expect(s).toMatchObject({ phase: 'pulling', message: 'pulling image big:1…', serviceId: 'svc1', finishedAt: null });
  });

  test('a first deploy (no live service yet) still reports pulling', () => {
    const s = withDeployProgress(null, { phase: 'pulling', message: null, startedAt: 0, at: 5 }, 'web');
    expect(s).toMatchObject({ deploymentId: 'web', serviceId: null, phase: 'pulling', message: 'pulling image…' });
  });
});
