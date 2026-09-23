import { describe, expect, it } from 'bun:test';
import { gateTarget } from './terminal';
import type { TermStartPayload } from '@swarmy/core/protocol';

const container: TermStartPayload['target'] = { kind: 'container', containerId: 'c1', cmd: [] };
const nodeShell: TermStartPayload['target'] = { kind: 'nodeShell', cmd: [] };
const none = { exec: undefined, shell: undefined };

describe('gateTarget — container exec (default ON)', () => {
  it('is allowed on a fresh install: no env override, no/absent controller assertion', () => {
    expect(gateTarget(container, undefined, none)).toEqual({ ok: true });
    expect(gateTarget(container, true, none)).toEqual({ ok: true });
  });

  it('is refused when the node toggle is off (controller asserts nodeCapable=false) and says where to flip it', () => {
    const r = gateTarget(container, false, none);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('E_EXEC_DISABLED');
      expect(r.message).toContain('Container exec');
    }
  });

  it('SWARMY_ALLOW_EXEC=false vetoes locally and the message names the env var', () => {
    const r = gateTarget(container, true, { exec: 'deny', shell: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('SWARMY_ALLOW_EXEC=false');
  });

  it('SWARMY_ALLOW_EXEC=true forces it on over the node toggle', () => {
    expect(gateTarget(container, false, { exec: 'allow', shell: undefined })).toEqual({ ok: true });
  });
});

describe('gateTarget — host shell (default OFF)', () => {
  it('is refused without the controller assertion, even with every env flag on', () => {
    const r = gateTarget(nodeShell, undefined, { exec: 'allow', shell: 'allow' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('E_NODE_SHELL_DISABLED');
  });

  it('the exec flag never enables node shell', () => {
    expect(gateTarget(nodeShell, false, { exec: 'allow', shell: undefined }).ok).toBe(false);
  });

  it('is allowed with the Host shell toggle (nodeCapable=true) and no local veto', () => {
    expect(gateTarget(nodeShell, true, none)).toEqual({ ok: true });
  });

  it('SWARMY_ALLOW_NODE_SHELL=false vetoes even with the toggle on', () => {
    const r = gateTarget(nodeShell, true, { exec: undefined, shell: 'deny' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('SWARMY_ALLOW_NODE_SHELL=false');
  });
});
