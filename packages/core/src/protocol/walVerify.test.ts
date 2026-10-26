import { describe, expect, it } from 'bun:test';
import { DbWalVerifyMsg, DbWalVerifyPayload, DbWalVerifyResult } from './walVerify';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { DEFAULT_COMMAND_TIMEOUTS } from './constants';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';

/** testing-conventions invariant 5: the `dbWalVerify` command parses, and only as itself. */

const CMD_ID = '00000000-0000-4000-8000-000000000081';
const REPO = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' };
const CONN = { host: 'shop_main-primary', password: 'pw' };
const minimal = { commandId: CMD_ID, engine: 'wal-g', repo: REPO, conn: CONN };

describe('DbWalVerifyPayload', () => {
  it('accepts a minimal wal-g payload; the connection takes its defaults, networks stay optional', () => {
    const r = DbWalVerifyPayload.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.conn).toEqual({ host: 'shop_main-primary', port: 5432, user: 'postgres', password: 'pw', database: 'app' });
      expect(r.data.network).toBeUndefined();
      expect(r.data.engineImage).toBeUndefined();
    }
  });

  it('rejects another engine, a missing connection, a missing repo and a missing commandId', () => {
    expect(DbWalVerifyPayload.safeParse({ ...minimal, engine: 'pgbackrest' }).success).toBe(false);
    expect(DbWalVerifyPayload.safeParse({ commandId: CMD_ID, engine: 'wal-g', repo: REPO }).success).toBe(false);
    expect(DbWalVerifyPayload.safeParse({ commandId: CMD_ID, engine: 'wal-g', conn: CONN }).success).toBe(false);
    expect(DbWalVerifyPayload.safeParse({ engine: 'wal-g', repo: REPO, conn: CONN }).success).toBe(false);
  });
});

describe('DbWalVerifyMsg', () => {
  it('wraps the payload with the dbWalVerify discriminant and is a ControllerToAgentMessage', () => {
    expect(DbWalVerifyMsg.safeParse({ type: 'dbWalVerify', payload: minimal }).success).toBe(true);
    const r = ControllerToAgentMessage.safeParse({ type: 'dbWalVerify', payload: minimal });
    expect(r.success && r.data.type).toBe('dbWalVerify');
    const env = parseControllerEnvelope({ v: 1, id: '00000000-0000-4000-8000-000000000082', ts: 1, type: 'dbWalVerify', payload: minimal });
    expect(env.type).toBe('dbWalVerify');
  });

  it('rejects a wrong type literal, and a window payload (no connection) under this type', () => {
    expect(DbWalVerifyMsg.safeParse({ type: 'dbPitrWindow', payload: minimal }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'dbWalVerifys', payload: minimal }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'dbWalVerify', payload: { commandId: CMD_ID, engine: 'wal-g', repo: REPO } }).success).toBe(false);
  });
});

describe('DbWalVerifyResult', () => {
  it('round-trips ranges with their times, the timeline check and the base backups', () => {
    const result = {
      integrity: 'failure' as const,
      ranges: [
        { timeline: 1, startSegment: '000000010000000000000002', endSegment: '000000010000000000000009', segments: 8, status: 'found' as const, from: '2026-10-20T03:00:00.000Z', to: '2026-10-21T13:10:00.000Z' },
        { timeline: 1, startSegment: '00000001000000000000000A', endSegment: '00000001000000000000000B', segments: 2, status: 'lost' as const, from: '2026-10-21T13:10:00.000Z', to: '2026-10-21T13:25:00.000Z' },
      ],
      timeline: { status: 'ok' as const, current: 1, highestInStorage: 1 },
      backups: [{ name: 'base_000000010000000000000002', finishTime: '2026-10-20T03:00:00.000Z' }],
      checkedAt: '2026-10-24T09:01:00.000Z',
    };
    expect(DbWalVerifyResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('ranges and backups default to none; a status outside OK/WARNING/FAILURE and an unknown range state are refused', () => {
    const r = DbWalVerifyResult.parse({ integrity: 'ok', checkedAt: 'x' });
    expect(r.ranges).toEqual([]);
    expect(r.backups).toEqual([]);
    expect(DbWalVerifyResult.safeParse({ integrity: 'OK', checkedAt: 'x' }).success).toBe(false);
    expect(
      DbWalVerifyResult.safeParse({ integrity: 'ok', checkedAt: 'x', ranges: [{ timeline: 1, startSegment: 'a', endSegment: 'b', segments: 1, status: 'gone' }] }).success,
    ).toBe(false);
  });
});

describe('the dbWalVerify capability', () => {
  it('this agent build advertises it; an agent without it is never sent the command', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.dbWalVerify);
    expect(agentSupports(['dbPitrWindow'], 'dbWalVerify')).toBe(false);
    expect(agentSupports(['dbPitrWindow', 'dbWalVerify'], 'dbWalVerify')).toBe(true);
  });

  it('has a bounded default timeout like the window check', () => {
    expect(DEFAULT_COMMAND_TIMEOUTS.dbWalVerify).toBe(300_000);
  });
});
