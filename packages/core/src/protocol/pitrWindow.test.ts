import { describe, expect, it } from 'bun:test';
import { DbPitrWindowMsg, DbPitrWindowPayload, DbPitrWindowResult } from './pitrWindow';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { NodeFacts } from './auth';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';

/** testing-conventions invariant 5: the `dbPitrWindow` command parses, and only as itself. */

const CMD_ID = '00000000-0000-4000-8000-000000000071';
const REPO = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' };
const minimal = { commandId: CMD_ID, engine: 'wal-g', repo: REPO };

describe('DbPitrWindowPayload', () => {
  it('accepts a minimal wal-g payload; the networks and image stay optional', () => {
    const r = DbPitrWindowPayload.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.network).toBeUndefined();
      expect(r.data.resticNetwork).toBeUndefined();
      expect(r.data.engineImage).toBeUndefined();
    }
  });

  it('carries the same networks the restore joins', () => {
    const r = DbPitrWindowPayload.safeParse({ ...minimal, network: 'shop_main-net', resticNetwork: 'swarmy' });
    expect(r.success && r.data.network === 'shop_main-net' && r.data.resticNetwork === 'swarmy').toBe(true);
  });

  it('rejects a logical engine, pgbackrest, a missing repo, and a missing commandId', () => {
    expect(DbPitrWindowPayload.safeParse({ ...minimal, engine: 'pg_dump' }).success).toBe(false);
    expect(DbPitrWindowPayload.safeParse({ ...minimal, engine: 'pgbackrest' }).success).toBe(false);
    expect(DbPitrWindowPayload.safeParse({ commandId: CMD_ID, engine: 'wal-g' }).success).toBe(false);
    expect(DbPitrWindowPayload.safeParse({ engine: 'wal-g', repo: REPO }).success).toBe(false);
  });
});

describe('DbPitrWindowMsg', () => {
  it('wraps the payload with the dbPitrWindow discriminant', () => {
    const r = DbPitrWindowMsg.safeParse({ type: 'dbPitrWindow', payload: minimal });
    expect(r.success).toBe(true);
  });

  it('is a ControllerToAgentMessage variant, and the envelope parses', () => {
    const r = ControllerToAgentMessage.safeParse({ type: 'dbPitrWindow', payload: minimal });
    expect(r.success && r.data.type).toBe('dbPitrWindow');
    const env = parseControllerEnvelope({ v: 1, id: '00000000-0000-4000-8000-000000000072', ts: 1, type: 'dbPitrWindow', payload: minimal });
    expect(env.type).toBe('dbPitrWindow');
  });

  it('rejects a wrong type literal, and a dbRestore payload under this type', () => {
    expect(DbPitrWindowMsg.safeParse({ type: 'dbRestore', payload: minimal }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'dbPitrWindows', payload: minimal }).success).toBe(false);
    expect(ControllerToAgentMessage.safeParse({ type: 'dbPitrWindow', payload: { commandId: CMD_ID, mode: 'pitr' } }).success).toBe(false);
  });
});

describe('DbPitrWindowResult', () => {
  it('round-trips a window with its base backups; backups default to none', () => {
    const result = {
      backups: [{ name: 'base_000000010000000000000002', finishTime: '2026-10-20T03:00:00.000Z' }],
      window: { from: '2026-10-20T03:00:00.000Z', to: '2026-10-24T09:00:00.000Z' },
      latestWalAt: '2026-10-24T09:00:00.000Z',
      checkedAt: '2026-10-24T09:01:00.000Z',
    };
    expect(DbPitrWindowResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(DbPitrWindowResult.parse({ window: null, checkedAt: 'x' }).backups).toEqual([]);
  });

  it('a base backup may carry its data size, a whole non-negative number', () => {
    const backup = { name: 'base_1', finishTime: '2026-10-20T03:00:00.000Z', sizeBytes: 268_435_456 };
    expect(DbPitrWindowResult.parse({ backups: [backup], window: null, checkedAt: 'x' }).backups).toEqual([backup]);
    expect(DbPitrWindowResult.safeParse({ backups: [{ ...backup, sizeBytes: -1 }], window: null, checkedAt: 'x' }).success).toBe(false);
  });

  it('a window needs both ends, and checkedAt is required', () => {
    expect(DbPitrWindowResult.safeParse({ window: { from: 'a' }, checkedAt: 'x' }).success).toBe(false);
    expect(DbPitrWindowResult.safeParse({ window: null }).success).toBe(false);
  });
});

describe('agent capabilities', () => {
  it('this agent build advertises dbPitrWindow', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.dbPitrWindow);
  });

  it('an agent that predates the list (or omits the command) does not support it', () => {
    expect(agentSupports(undefined, 'dbPitrWindow')).toBe(false);
    expect(agentSupports([], 'dbPitrWindow')).toBe(false);
    expect(agentSupports(['dbPitrWindow'], 'dbPitrWindow')).toBe(true);
  });

  it('register facts carry the list additively: older facts without it still parse', () => {
    const facts = {
      hostname: 'db-1', os: 'Linux', arch: 'x64', cpuCount: 2, memTotalBytes: 1, dockerVersion: '27',
      swarmRole: 'manager', agentVersion: '1.4.0', protocolVersions: [1],
    };
    expect(NodeFacts.safeParse(facts).success).toBe(true);
    const r = NodeFacts.safeParse({ ...facts, capabilities: ['dbPitrWindow'] });
    expect(r.success && r.data.capabilities).toEqual(['dbPitrWindow']);
    expect(NodeFacts.safeParse({ ...facts, capabilities: 'dbPitrWindow' }).success).toBe(false);
  });
});
