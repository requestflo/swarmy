import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { canRestartAgent, restartNodeAgent, waitForReRegister } from './node-agent-restart.service';

/**
 * "Restart agent" (board 11): only an agent that advertised `restartAgent`
 * gets the command; the controller then waits for the next register and
 * reports how long the agent was gone. Against an in-memory hub and a fake clock.
 */

function world(opts: { capabilities?: string[]; backAfterMs?: number | null; fail?: string } = {}) {
  let t = 1_000_000;
  let registeredAt = t - 60_000;
  let restartAt: number | null = null;
  const calls: string[] = [];
  const audits: Array<{ action: string; metadata?: unknown }> = [];
  const hub = {
    isOnline: () => true,
    agentBuildFor: () => {
      // The agent comes back `backAfterMs` after the restart was asked for.
      if (restartAt !== null && opts.backAfterMs != null && t >= restartAt + opts.backAfterMs) registeredAt = restartAt + opts.backAfterMs;
      return { version: '1.6.0', registeredAt, ...(opts.capabilities ? { capabilities: opts.capabilities } : {}) };
    },
    dispatch: async (_n: string, cmd: string) => {
      calls.push(cmd);
      if (opts.fail) throw new Error(opts.fail);
      restartAt = t;
      return { restarting: true, supervisor: 'systemd', exitCode: 0 };
    },
  };
  const db = {
    node: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'n1' ? { id: 'n1' } : null) },
    auditLog: { create: async ({ data }: { data: { action: string; metadata?: unknown } }) => void audits.push(data) },
  };
  const ctx = { db, hub, user: { id: 'u1' }, activeOrgId: 'org-1' } as unknown as OrgContext;
  const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
  return { ctx, calls, audits, clock };
}

describe('restartNodeAgent', () => {
  it('restarts, audits and says how long the agent was gone', async () => {
    const w = world({ capabilities: ['restartAgent'], backAfterMs: 6_000 });
    const r = await restartNodeAgent(w.ctx, 'n1', w.clock);
    expect(r).toEqual({ id: 'n1', supervisor: 'systemd', backInMs: 6_000 });
    expect(w.calls).toEqual(['agent.restart']);
    expect(w.audits).toEqual([expect.objectContaining({ action: 'node.agent.restart', metadata: { supervisor: 'systemd' } })]);
  });

  it('reports null when the agent is not back within the wait', async () => {
    const w = world({ capabilities: ['restartAgent'], backAfterMs: null });
    const r = await restartNodeAgent(w.ctx, 'n1', { ...w.clock, waitMs: 5_000 });
    expect(r.backInMs).toBeNull();
  });

  it('never sends the command to an agent that did not advertise it', async () => {
    const w = world({ capabilities: ['dbPitrWindow'] });
    expect(canRestartAgent(w.ctx, 'n1')).toBe(false);
    await expect(restartNodeAgent(w.ctx, 'n1', w.clock)).rejects.toThrow(/too old to restart/);
    expect(w.calls).toEqual([]);
    expect(w.audits).toEqual([]);
  });

  it("passes the agent's refusal on and audits nothing", async () => {
    const w = world({ capabilities: ['restartAgent'], fail: 'nothing would start it again' });
    await expect(restartNodeAgent(w.ctx, 'n1', w.clock)).rejects.toThrow(/nothing would start it again/);
    expect(w.audits).toEqual([]);
  });

  it('refuses a server outside the org', async () => {
    const w = world({ capabilities: ['restartAgent'] });
    await expect(restartNodeAgent(w.ctx, 'other', w.clock)).rejects.toThrow(/not found/);
  });
});

describe('waitForReRegister', () => {
  it('ignores the register from before the restart', async () => {
    const w = world({ capabilities: ['restartAgent'] });
    expect(await waitForReRegister(w.ctx, 'n1', w.clock.now(), { ...w.clock, waitMs: 1_000 })).toBeNull();
  });
});
