import { describe, expect, it } from 'bun:test';
import { NODE_EXEC_LABEL, NODE_SHELL_LABEL } from '@swarmy/core';
import type { AgentHub } from '../hub/types';
import type { OrgContext } from '../context';
import { terminalCapability } from './terminal.service';
import { removeNodeBlockReason, setNodeLabels, setNodeRole } from './node.service';

type Overrides = { execOverride?: 'allow' | 'deny'; shellOverride?: 'allow' | 'deny' };

function hubFor(labels: Record<string, string> | undefined, overrides: Overrides = {}) {
  return {
    nodeInfoFor: () => (labels ? { labels } : undefined),
    agentBuildFor: () => ({ version: '1', ...overrides }),
  } as unknown as Pick<AgentHub, 'nodeInfoFor' | 'agentBuildFor'>;
}

describe('terminalCapability — container exec (default on)', () => {
  it('a fresh node with no label and no env override accepts exec', () => {
    expect(terminalCapability(hubFor(undefined), 'n1', 'container').capable).toBe(true);
    expect(terminalCapability(hubFor({}), 'n1', 'container').capable).toBe(true);
  });

  it('the node toggle off → EXEC_DISABLED_ON_NODE, pointing at Controls', () => {
    const c = terminalCapability(hubFor({ [NODE_EXEC_LABEL]: 'false' }), 'n1', 'container');
    expect(c).toMatchObject({ capable: false, blockedBy: 'node-toggle', swarmyCode: 'EXEC_DISABLED_ON_NODE' });
    expect(c.message).toContain('Container exec');
  });

  it('SWARMY_ALLOW_EXEC=false on the box → EXEC_BLOCKED_LOCALLY naming the env var', () => {
    const c = terminalCapability(hubFor({}, { execOverride: 'deny' }), 'n1', 'container');
    expect(c).toMatchObject({ capable: false, blockedBy: 'local-env', swarmyCode: 'EXEC_BLOCKED_LOCALLY' });
    expect(c.message).toContain('SWARMY_ALLOW_EXEC=false');
  });
});

describe('terminalCapability — host shell (default off)', () => {
  it('off without the label, even with SWARMY_ALLOW_NODE_SHELL=true', () => {
    expect(terminalCapability(hubFor({}), 'n1', 'nodeShell')).toMatchObject({
      capable: false,
      swarmyCode: 'NODE_SHELL_OFF_ON_NODE',
    });
    expect(terminalCapability(hubFor({}, { shellOverride: 'allow' }), 'n1', 'nodeShell').capable).toBe(false);
  });

  it('on with swarmy.node.shell=true; SWARMY_ALLOW_NODE_SHELL=false vetoes', () => {
    expect(terminalCapability(hubFor({ [NODE_SHELL_LABEL]: 'true' }), 'n1', 'nodeShell').capable).toBe(true);
    expect(
      terminalCapability(hubFor({ [NODE_SHELL_LABEL]: 'true' }, { shellOverride: 'deny' }), 'n1', 'nodeShell'),
    ).toMatchObject({ capable: false, blockedBy: 'local-env', swarmyCode: 'NODE_SHELL_BLOCKED_LOCALLY' });
  });

  it('the exec override never widens the shell gate', () => {
    expect(terminalCapability(hubFor({}, { execOverride: 'allow' }), 'n1', 'nodeShell').capable).toBe(false);
  });
});

describe('setNodeRole — terminal capability toggles are labelled + audited', () => {
  function fakeCtx(labels: Record<string, string> = {}) {
    const dispatched: { cmd: string; payload: { labels: Record<string, string> } }[] = [];
    const audits: { action: string; targetId: string | null; metadata: Record<string, unknown> }[] = [];
    const ctx = {
      activeOrgId: 'org',
      user: { id: 'u1' },
      db: {
        node: { findFirst: async () => ({ id: 'n1' }) },
        auditLog: {
          create: async ({ data }: { data: (typeof audits)[number] }) => {
            audits.push(data);
            return data;
          },
        },
      },
      hub: {
        nodeInfoFor: () => ({ labels }),
        swarmNodeIdFor: () => 'swarm-n1',
        managerNode: () => 'mgr',
        isOnline: () => true,
        dispatch: async (_via: string, cmd: string, payload: { labels: Record<string, string> }) => {
          dispatched.push({ cmd, payload });
          return {};
        },
      },
    } as unknown as OrgContext;
    return { ctx, dispatched, audits };
  }

  it('turning the host shell on stamps swarmy.node.shell=true and audits node.shell.enable', async () => {
    const { ctx, dispatched, audits } = fakeCtx();
    const r = await setNodeRole(ctx, 'n1', { shell: true });
    expect(r.shell).toBe(true);
    expect(dispatched[0]?.cmd).toBe('node.update');
    expect(dispatched[0]?.payload.labels).toEqual({ [NODE_SHELL_LABEL]: 'true' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'node.shell.enable', targetId: 'n1' });
  });

  it('turning exec off writes swarmy.node.exec=false and audits node.exec.disable', async () => {
    const { ctx, dispatched, audits } = fakeCtx();
    const r = await setNodeRole(ctx, 'n1', { exec: false });
    expect(r.exec).toBe(false);
    expect(dispatched[0]?.payload.labels).toEqual({ [NODE_EXEC_LABEL]: 'false' });
    expect(audits.map((a) => a.action)).toEqual(['node.exec.disable']);
  });

  it('non-capability role toggles do not write a capability audit row', async () => {
    const { ctx, audits } = fakeCtx();
    const r = await setNodeRole(ctx, 'n1', { builder: true });
    expect(r.exec).toBe(true); // default-on
    expect(r.shell).toBe(false); // default-off
    expect(audits).toHaveLength(0);
  });

  it('the generic label editor cannot set the capability labels (bypass guard)', async () => {
    const { ctx, dispatched } = fakeCtx();
    await expect(setNodeLabels(ctx, 'n1', { [NODE_SHELL_LABEL]: 'true' })).rejects.toThrow(/Controls/);
    await expect(setNodeLabels(ctx, 'n1', { [NODE_EXEC_LABEL]: 'false' })).rejects.toThrow();
    expect(dispatched).toHaveLength(0);
  });
});

describe('removeNodeBlockReason', () => {
  const ctxWith = (opts: { online: boolean; managers: number; selfManager: boolean; controller: boolean }) =>
    ({
      activeOrgId: 'o1',
      hub: {
        isOnline: () => opts.online,
        swarmNodeIdFor: () => 's-self',
        nodeInventory: () => [
          { swarmNodeId: 's-self', role: opts.selfManager ? 'manager' : 'worker' },
          ...Array.from({ length: opts.managers - (opts.selfManager ? 1 : 0) }, (_, i) => ({ swarmNodeId: `m${i}`, role: 'manager' })),
        ],
        latestContainers: () =>
          opts.controller ? [{ labels: { 'com.docker.swarm.service.name': 'swarmy_controller' } }] : [],
      },
    }) as unknown as OrgContext;

  it('refuses the only manager and the controller host while online', () => {
    expect(removeNodeBlockReason(ctxWith({ online: true, managers: 1, selfManager: true, controller: false }), 'n')).toContain('only manager');
    expect(removeNodeBlockReason(ctxWith({ online: true, managers: 3, selfManager: true, controller: true }), 'n')).toContain('controller');
  });

  it('allows an extra manager, a worker, or any offline node', () => {
    expect(removeNodeBlockReason(ctxWith({ online: true, managers: 3, selfManager: true, controller: false }), 'n')).toBeNull();
    expect(removeNodeBlockReason(ctxWith({ online: true, managers: 1, selfManager: false, controller: false }), 'n')).toBeNull();
    expect(removeNodeBlockReason(ctxWith({ online: false, managers: 1, selfManager: true, controller: true }), 'n')).toBeNull();
  });
});
