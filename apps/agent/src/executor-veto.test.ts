/**
 * Local vetoes in the executor: `SWARMY_ALLOW_EXEC=false` covers every command
 * that execs into a task (studio, queues, app-DB backup/restore/verify), and
 * `runOnce` refuses binds outside its allowlist — both BEFORE Docker is touched.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import type { ControllerEnvelope } from '@swarmy/core/protocol';
import type { AgentConnection } from './connection';
import { env } from './env';
import { handleCommand } from './executor';

const CMD = '00000000-0000-4000-8000-0000000000aa';
const saved = env.EXEC_OVERRIDE;
afterEach(() => {
  env.EXEC_OVERRIDE = saved;
});

/** A Docker client that fails the test if anything reaches it. */
const untouchable = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'then') return undefined;
    throw new Error(`docker.${String(k)} was reached`);
  },
}) as unknown as DockerClient;

function capture() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const conn = { send: (type: string, payload: Record<string, unknown>) => sent.push({ type, payload }) } as unknown as AgentConnection;
  return { sent, conn };
}

const envlp = (type: string, payload: Record<string, unknown>) =>
  ({ v: 1, id: CMD, ts: 0, type, payload: { commandId: CMD, ...payload } }) as unknown as ControllerEnvelope;

describe('SWARMY_ALLOW_EXEC=false vetoes every exec-shaped command', () => {
  for (const type of ['dbQuery', 'queueOp', 'appDbBackup', 'appDbRestore', 'appDbVerify']) {
    it(`${type} is rejected with E_EXEC_DISABLED and never reaches Docker`, async () => {
      env.EXEC_OVERRIDE = 'deny';
      const { sent, conn } = capture();
      await handleCommand(untouchable, conn, envlp(type, {}));
      expect(sent).toHaveLength(1);
      expect(sent[0]!.type).toBe('commandResult');
      expect(sent[0]!.payload.status).toBe('rejected');
      expect((sent[0]!.payload.error as { code: string }).code).toBe('E_EXEC_DISABLED');
    });
  }
});

describe('runOnce bind allowlist at the agent', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['host root', { image: 'alpine:3.20', binds: ['/:/host'] }],
    ['docker socket for an arbitrary image', { image: 'alpine:3.20', binds: ['/var/run/docker.sock:/var/run/docker.sock'] }],
    ['a system path for restic', { image: 'restic/restic:0.16.4', binds: ['/etc:/etc'] }],
  ];
  for (const [what, payload] of cases) {
    it(`refuses ${what} with E_BIND_REFUSED before pulling or creating`, async () => {
      const { sent, conn } = capture();
      await handleCommand(untouchable, conn, envlp('runOnce', { pull: true, ...payload }));
      const last = sent.at(-1)!;
      expect(last.payload.status).toBe('failed');
      expect((last.payload.error as { code: string }).code).toBe('E_BIND_REFUSED');
    });
  }
});
