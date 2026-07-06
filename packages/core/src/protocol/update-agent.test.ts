import { describe, expect, it } from 'bun:test';
import { UpdateAgentPayload, UpdateAgentMsg } from './commands';
import { parseControllerEnvelope } from './messages';

const CMD_ID = '00000000-0000-4000-8000-000000000002';
const SHA = 'a'.repeat(64);

describe('UpdateAgentPayload', () => {
  it('accepts a self-replace payload with url + sha256 (and defaults the strategy)', () => {
    const r = UpdateAgentPayload.safeParse({
      commandId: CMD_ID,
      targetVersion: '0.2.0',
      downloadUrl: 'https://controller.example.com/install/bin/linux-x64',
      sha256: SHA,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.strategy).toBe('self-replace');
  });

  it('accepts a docker-recreate payload with only an image', () => {
    const r = UpdateAgentPayload.safeParse({
      commandId: CMD_ID,
      targetVersion: '0.2.0',
      strategy: 'docker-recreate',
      image: 'ghcr.io/requestflo/swarmy-agent:0.2.0',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a malformed sha256 and a non-URL download', () => {
    expect(
      UpdateAgentPayload.safeParse({ commandId: CMD_ID, targetVersion: '0.2.0', sha256: 'short' }).success,
    ).toBe(false);
    expect(
      UpdateAgentPayload.safeParse({ commandId: CMD_ID, targetVersion: '0.2.0', downloadUrl: 'not-a-url' })
        .success,
    ).toBe(false);
  });
});

describe('updateAgent over the wire', () => {
  it('round-trips through the controller envelope', () => {
    const msg = UpdateAgentMsg.parse({
      type: 'updateAgent',
      payload: {
        commandId: CMD_ID,
        targetVersion: '0.2.0',
        downloadUrl: 'https://controller.example.com/install/bin/linux-arm64',
        sha256: SHA,
      },
    });
    const env = parseControllerEnvelope({ v: 1, id: CMD_ID, ts: 1, type: msg.type, payload: msg.payload });
    expect(env.type).toBe('updateAgent');
    if (env.type === 'updateAgent') expect(env.payload.sha256).toBe(SHA);
  });
});
