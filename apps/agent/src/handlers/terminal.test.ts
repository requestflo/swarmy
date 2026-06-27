import { describe, expect, it } from 'bun:test';
import { gateTarget } from './terminal';
import type { TermStartPayload } from '@swarmy/core/protocol';

const container: TermStartPayload['target'] = { kind: 'container', containerId: 'c1', cmd: [] };
const nodeShell: TermStartPayload['target'] = { kind: 'nodeShell', cmd: [] };

describe('gateTarget — agent terminal gating', () => {
  it('container exec is allowed when SWARMY_ALLOW_EXEC is on', () => {
    expect(gateTarget(container, { allowExec: true, allowNodeShell: false })).toEqual({ ok: true });
  });

  it('container exec is denied when SWARMY_ALLOW_EXEC is off', () => {
    const r = gateTarget(container, { allowExec: false, allowNodeShell: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('E_EXEC_DISABLED');
  });

  it('node shell is denied unless SWARMY_ALLOW_NODE_SHELL is on (separate flag)', () => {
    // The container flag must NOT enable node shell.
    const r = gateTarget(nodeShell, { allowExec: true, allowNodeShell: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('E_NODE_SHELL_DISABLED');
  });

  it('node shell is allowed only with its own flag', () => {
    expect(gateTarget(nodeShell, { allowExec: false, allowNodeShell: true })).toEqual({ ok: true });
  });
});
