import { describe, expect, it } from 'bun:test';
import { DbWalgCopyMsg, DbWalgCopyPayload, DbWalgCopyResult } from './walgCopy';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { DEFAULT_COMMAND_TIMEOUTS } from './constants';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';

/** testing-conventions invariant 5: the `dbWalgCopy` command parses, and only as itself. */

const CMD_ID = '00000000-0000-4000-8000-000000000091';
const FROM = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' };
const TO = { kind: 's3' as const, repo: 's3:https://acct.r2.cloudflarestorage.com/offsite/pg', password: 'rp2', accessKeyId: 'AK', secretAccessKey: 'SK' };
const minimal = { commandId: CMD_ID, engine: 'wal-g', from: FROM, to: TO, backupName: 'base_000000010000000000000009' };

describe('DbWalgCopyPayload', () => {
  it('parses a minimal copy; the network and image are optional', () => {
    const r = DbWalgCopyPayload.safeParse(minimal);
    expect(r.success).toBe(true);
    expect(r.success && r.data.resticNetwork).toBeUndefined();
    expect(DbWalgCopyPayload.safeParse({ ...minimal, resticNetwork: 'swarmy', engineImage: 'walg:x' }).success).toBe(true);
  });

  it('refuses another engine, a missing side, or no backup name', () => {
    expect(DbWalgCopyPayload.safeParse({ ...minimal, engine: 'pgbackrest' }).success).toBe(false);
    expect(DbWalgCopyPayload.safeParse({ ...minimal, to: undefined }).success).toBe(false);
    expect(DbWalgCopyPayload.safeParse({ ...minimal, backupName: '' }).success).toBe(false);
    expect(DbWalgCopyPayload.safeParse({ ...minimal, commandId: undefined }).success).toBe(false);
  });
});

describe('DbWalgCopyMsg', () => {
  it('wraps the payload with the dbWalgCopy discriminant, also through the union and the envelope', () => {
    expect(DbWalgCopyMsg.safeParse({ type: 'dbWalgCopy', payload: minimal }).success).toBe(true);
    const r = ControllerToAgentMessage.safeParse({ type: 'dbWalgCopy', payload: minimal });
    expect(r.success && r.data.type).toBe('dbWalgCopy');
    const env = parseControllerEnvelope({ v: 1, id: '00000000-0000-4000-8000-000000000092', ts: 1, type: 'dbWalgCopy', payload: minimal });
    expect(env.type).toBe('dbWalgCopy');
  });

  it('a wrong type literal or another command’s payload is refused', () => {
    expect(DbWalgCopyMsg.safeParse({ type: 'dbPitrWindow', payload: minimal }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'dbWalgCopies', payload: minimal }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'dbWalgCopy', payload: { commandId: CMD_ID, engine: 'wal-g', repo: FROM } }).success).toBe(false);
  });
});

describe('DbWalgCopyResult', () => {
  it('the base backup copied and the copy’s own window round-trip', () => {
    const result = {
      backupName: 'base_000000010000000000000009',
      backups: [{ name: 'base_000000010000000000000009', finishTime: '2026-10-27T03:00:00.000Z' }],
      window: { from: '2026-10-27T03:00:00.000Z', to: '2026-10-27T03:04:00.000Z' },
      latestWalAt: '2026-10-27T03:04:00.000Z',
      checkedAt: '2026-10-27T03:05:00.000Z',
    };
    expect(DbWalgCopyResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(DbWalgCopyResult.safeParse({ window: null, checkedAt: 'x' }).success).toBe(false);
  });
});

describe('the dbWalgCopy capability', () => {
  it('this agent build advertises it; an agent without it is never sent the command', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.dbWalgCopy);
    expect(agentSupports(['dbPitrWindow', 'dbWalVerify'], 'dbWalgCopy')).toBe(false);
    expect(agentSupports(['dbWalgCopy'], 'dbWalgCopy')).toBe(true);
  });

  it('has a long default timeout, like a backup', () => {
    expect(DEFAULT_COMMAND_TIMEOUTS.dbWalgCopy).toBe(4 * 3_600_000);
  });
});
