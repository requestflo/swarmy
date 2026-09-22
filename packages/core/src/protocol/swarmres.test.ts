import { describe, expect, it } from 'bun:test';
import { RunOnceMsg, RunOncePayload } from './swarmres';
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
