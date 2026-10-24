import { describe, expect, it } from 'bun:test';
import { demoRunView, newDemoRun, type RunHost } from './platform-run';

const T0 = Date.parse('2026-10-24T10:00:00Z');
const s = (n: number) => T0 + n * 1_000;

function host(): RunHost {
  return { current: '1.2.4', history: [], run: { ...newDemoRun(), startedAt: new Date(T0).toISOString() } };
}

describe('demo platform run — pause after this step', () => {
  it('lands once the current step finishes, then resumes where it stopped', () => {
    const p = host();
    p.run!.pauseAt = 1; // asked during the controller step (6–12 s)
    p.run!.pauseAskedAt = new Date(s(7)).toISOString();
    expect(demoRunView(p, s(7))).toMatchObject({ status: 'running', step: 'controller', pause: { by: 'u1' } });
    const v = demoRunView(p, s(13));
    expect(v).toMatchObject({ status: 'paused', step: 'agents', pause: null });
    expect(v.abandon).toEqual({ putBack: [], kept: [{ key: 'controller', why: expect.stringContaining('database already moved forward') }] });
    // Still paused a minute later: nothing moves on its own.
    expect(demoRunView(p, s(70)).step).toBe('agents');
    // Resume at 70 s: 58 s of pause shift the rest.
    p.run!.shifts.push({ fromIdx: 2, ms: s(70) - p.run!.paused!.since });
    p.run!.paused = null;
    p.run!.pauseAt = null;
    expect(demoRunView(p, s(71))).toMatchObject({ status: 'running', step: 'agents' });
    expect(demoRunView(p, s(101))).toMatchObject({ status: 'done' });
    expect(p.current).toBe('1.3.0');
  });

  it('abandon puts back the mesh clients, the system services, then the agents; the controller stays', () => {
    const p = host();
    p.run!.pauseAt = 3;
    expect(demoRunView(p, s(25))).toMatchObject({ status: 'paused', step: 'mesh', abandon: { putBack: ['system', 'agents'] } });
    p.run!.abandon = { since: s(30) };
    expect(demoRunView(p, s(31))).toMatchObject({ status: 'abandoning', step: 'system' });
    expect(demoRunView(p, s(35))).toMatchObject({ status: 'abandoning', step: 'agents' });
    const v = demoRunView(p, s(39));
    expect(v.status).toBe('abandoned');
    expect(v.steps.map((x) => x.status)).toEqual(['done', 'done', 'rolled-back', 'rolled-back', 'pending', 'pending', 'pending']);
    expect(p.history[0]).toMatchObject({ status: 'abandoned', toVersion: '1.3.0' });
    expect(p.current).toBe('1.2.4');
  });

  it('a pause asked on the last step is moot: the run finishes', () => {
    const p = host();
    p.run!.pauseAt = 6;
    expect(demoRunView(p, s(46)).status).toBe('done');
  });
});
