import { describe, expect, it } from 'bun:test';
import { COPY_KEY_LABEL, RunOnceMsg, RunOncePayload, RunOnceResult } from './swarmres';
import { ControllerToAgentMessage } from './messages';

const CMD_ID = '00000000-0000-4000-8000-000000000001';

describe('RunOncePayload.user', () => {
  it('is optional (existing callers unchanged) and pull still defaults to true', () => {
    const r = RunOncePayload.safeParse({ commandId: CMD_ID, image: 'busybox:1.36' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.user).toBeUndefined();
      expect(r.data.pull).toBe(true);
    }
  });

  it('accepts uid, uid:gid and named users', () => {
    for (const user of ['0', '0:0', '65532:65532', 'root', 'nobody:nogroup']) {
      expect(RunOncePayload.safeParse({ commandId: CMD_ID, image: 'x', user }).success).toBe(true);
    }
  });

  it('rejects empty or shell-y users', () => {
    for (const user of ['', '0:0:0', 'root; rm -rf /', '../x']) {
      expect(RunOncePayload.safeParse({ commandId: CMD_ID, image: 'x', user }).success).toBe(false);
    }
  });
});

describe('RunOnceMsg round-trip through ControllerToAgentMessage', () => {
  it('carries user across JSON serialise → discriminated-union parse', () => {
    const msg = {
      type: 'runOnce' as const,
      payload: {
        commandId: CMD_ID,
        image: 'gcr.io/projectsigstore/cosign:v2.4.1',
        cmd: ['generate-key-pair', '--output-key-prefix', '/keys/cosign'],
        env: { COSIGN_PASSWORD: 'pw' },
        binds: ['swarmy-cosign-keygen-org:/keys'],
        user: '0:0',
        pull: true,
      },
    };
    const wire = JSON.parse(JSON.stringify(RunOnceMsg.parse(msg)));
    const parsed = ControllerToAgentMessage.parse(wire);
    expect(parsed.type).toBe('runOnce');
    if (parsed.type === 'runOnce') {
      expect(parsed.payload.user).toBe('0:0');
      expect(parsed.payload).toEqual(msg.payload);
    }
  });
});

describe('RunOnce copyKey / alreadyRunning (additive)', () => {
  const KEY = `ghcr.io/requestflo/swarmy-dns@sha256:${'a'.repeat(64)}`;

  it('copyKey rides the union; absent stays absent; empty is refused', () => {
    const wire = JSON.parse(JSON.stringify({ type: 'runOnce', payload: { commandId: CMD_ID, image: 'regctl', copyKey: KEY } }));
    const parsed = ControllerToAgentMessage.parse(wire);
    expect(parsed.type === 'runOnce' && parsed.payload.copyKey).toBe(KEY);
    expect(RunOncePayload.parse({ commandId: CMD_ID, image: 'x' }).copyKey).toBeUndefined();
    expect(RunOncePayload.safeParse({ commandId: CMD_ID, image: 'x', copyKey: '' }).success).toBe(false);
    expect(RunOnceMsg.safeParse({ type: 'runOnceX', payload: { commandId: CMD_ID, image: 'x', copyKey: KEY } }).success).toBe(false);
  });

  it('a result says whether the copy was already running; older results parse without it', () => {
    expect(RunOnceResult.parse({ exitCode: 0, output: '', alreadyRunning: true }).alreadyRunning).toBe(true);
    expect(RunOnceResult.parse({ exitCode: 0, output: 'x' }).alreadyRunning).toBeUndefined();
    expect(COPY_KEY_LABEL).toBe('swarmy.copy.key');
  });
});
