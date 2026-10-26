import { describe, expect, it } from 'bun:test';
import { CommandProgress, CommandResultPayload } from './results';
import { DbRestorePayload } from './dbBackup';
import { ControllerToAgentMessage, parseAgentEnvelope } from './messages';

/**
 * testing-conventions invariant 5, for restore progress: the controller opts
 * in on `dbRestore` (`reportProgress`), and the agent answers with `running`
 * frames whose progress carries a restore stage. Both additions are optional,
 * so every frame from before them still parses.
 */

const CMD_ID = '00000000-0000-4000-8000-0000000000a1';
const REPO = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/bkt/pfx', password: 'rp' };
const RESTORE = { commandId: CMD_ID, engine: 'wal-g', mode: 'pitr', conn: { host: 'shop_main-primary', password: '' }, repo: REPO };

describe('CommandProgress with a restore stage', () => {
  it('parses a restore frame, and the deploy pull frame from before it', () => {
    expect(CommandProgress.parse({ phase: 'restoring', restore: { stage: 'base', bytesDone: 10, bytesTotal: 40 } })).toEqual({
      phase: 'restoring',
      restore: { stage: 'base', bytesDone: 10, bytesTotal: 40 },
    });
    expect(CommandProgress.parse({ phase: 'pulling', message: 'pulling image big…' })).toEqual({ phase: 'pulling', message: 'pulling image big…' });
  });

  it('refuses an unknown stage or phase, a percent past 100 and negative bytes', () => {
    expect(CommandProgress.safeParse({ phase: 'restoring', restore: { stage: 'replay' } }).success).toBe(false);
    expect(CommandProgress.safeParse({ phase: 'unpacking' }).success).toBe(false);
    expect(CommandProgress.safeParse({ phase: 'restoring', restore: { stage: 'download', percent: 101 } }).success).toBe(false);
    expect(CommandProgress.safeParse({ phase: 'restoring', restore: { stage: 'download', bytesDone: -1 } }).success).toBe(false);
  });

  it('rides a running commandResult through the agent envelope', () => {
    const payload = { commandId: CMD_ID, status: 'running', progress: { phase: 'restoring', restore: { stage: 'wal', segments: 16 } } };
    expect(CommandResultPayload.safeParse(payload).success).toBe(true);
    const env = parseAgentEnvelope({ v: 1, id: '00000000-0000-4000-8000-0000000000a2', ts: 1, type: 'commandResult', payload });
    expect(env.type === 'commandResult' && env.payload.progress?.restore).toEqual({ stage: 'wal', segments: 16 });
  });
});

describe('DbRestorePayload.reportProgress', () => {
  it('is optional: absent by default, and a boolean when the controller asks', () => {
    expect(DbRestorePayload.parse(RESTORE).reportProgress).toBeUndefined();
    expect(DbRestorePayload.parse({ ...RESTORE, reportProgress: true }).reportProgress).toBe(true);
    expect(DbRestorePayload.safeParse({ ...RESTORE, reportProgress: 'yes' }).success).toBe(false);
  });

  it('a dbRestore asking for progress is still a dbRestore message', () => {
    const r = ControllerToAgentMessage.safeParse({ type: 'dbRestore', payload: { ...RESTORE, reportProgress: true } });
    expect(r.success && r.data.type).toBe('dbRestore');
  });
});
