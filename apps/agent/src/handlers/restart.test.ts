import { describe, expect, it } from 'bun:test';
import { restartAgent, restartPlan, type SupervisorFacts } from './restart';

const docker = (restartPolicy: string | undefined, swarmTask = false): SupervisorFacts => ({ container: { restartPolicy, swarmTask } });

describe('restartPlan: who brings the agent back', () => {
  it('systemd (Restart=always) restarts a clean exit', () => {
    expect(restartPlan({ invocationId: 'abc', container: null })).toEqual({ ok: true, supervisor: 'systemd', exitCode: 0 });
  });

  it("Docker's always / unless-stopped restart a clean exit; on-failure needs exit 1", () => {
    expect(restartPlan(docker('unless-stopped'))).toEqual({ ok: true, supervisor: 'docker', exitCode: 0 });
    expect(restartPlan(docker('always'))).toEqual({ ok: true, supervisor: 'docker', exitCode: 0 });
    expect(restartPlan(docker('on-failure'))).toEqual({ ok: true, supervisor: 'docker', exitCode: 1 });
  });

  it('a swarm task is replaced by the scheduler (exit 1 covers an on-failure condition)', () => {
    expect(restartPlan(docker('', true))).toEqual({ ok: true, supervisor: 'swarm', exitCode: 1 });
  });

  it('refuses when nothing would start it again', () => {
    const bare = restartPlan({ container: null });
    expect(bare.ok).toBe(false);
    const noPolicy = restartPlan(docker('no'));
    expect(noPolicy.ok).toBe(false);
    if (!noPolicy.ok) expect(noPolicy.reason).toContain('no restart policy (no)');
  });
});

describe('restartAgent', () => {
  it('answers first and leaves with the plan’s exit code', async () => {
    const left: number[] = [];
    const r = await restartAgent({ facts: async () => docker('on-failure'), leave: (c) => left.push(c) });
    expect(r).toEqual({ restarting: true, supervisor: 'docker', exitCode: 1 });
    expect(left).toEqual([1]);
  });

  it('refuses with E_NO_SUPERVISOR and never leaves', async () => {
    const left: number[] = [];
    const err = await restartAgent({ facts: async () => ({ container: null }), leave: (c) => left.push(c) }).catch((e) => e);
    expect((err as { code?: string }).code).toBe('E_NO_SUPERVISOR');
    expect(left).toEqual([]);
  });
});
