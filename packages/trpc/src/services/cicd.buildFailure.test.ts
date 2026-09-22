import { describe, expect, it } from 'bun:test';
import { buildFailureError } from './cicd.service';

describe('buildFailureError', () => {
  it('keeps an agent build failure verbatim (incl. its log tail) as COMMAND_REJECTED', () => {
    const e = new Error('build exited 1\nerror: failed to solve: dial tcp: i/o timeout');
    const out = buildFailureError(e, []);
    expect(out.code).toBe('BAD_REQUEST');
    // not re-classified as a dispatch timeout just because a log line says "timeout"
    expect(out.message).toBe('build exited 1\nerror: failed to solve: dial tcp: i/o timeout');
    expect((out.cause as { swarmyCode?: string }).swarmyCode).toBe('COMMAND_REJECTED');
  });

  it('appends the last build-log lines to a dispatch-level failure', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ message: `line ${i}\n` }));
    const out = buildFailureError(new Error('command timeout'), lines);
    expect(out.code).toBe('TIMEOUT');
    const msg = out.message.split('\n');
    expect(msg[0]).toBe('agent did not respond in time');
    expect(msg.slice(1)).toEqual(Array.from({ length: 15 }, (_, i) => `line ${i + 5}`));
  });

  it('falls back to the mapped error when there are no log lines', () => {
    const out = buildFailureError(new Error('node n1 is offline'), []);
    expect((out.cause as { swarmyCode?: string }).swarmyCode).toBe('NODE_OFFLINE');
  });
});
