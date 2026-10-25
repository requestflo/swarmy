import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readEdgeCerts } from './edge-certs';
import { edgeCertsExec, TRUNCATED_MARK } from './edge-certs-parse';

/** A docker socket stand-in: the listed tasks, and one exec that prints `stdout` (multiplexed) and exits. */
function fakeDocker(running: Array<{ Id: string }>, stdout: string, exitCode = 0, stderr = '') {
  const calls: Array<{ id: string; cmd: string[]; env?: string[] }> = [];
  const frame = (type: number, text: string) => {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  const docker = {
    docker: {
      listContainers: async () => running,
      getContainer: (id: string) => ({
        exec: async (o: { Cmd: string[]; Env?: string[] }) => {
          calls.push({ id, cmd: o.Cmd, env: o.Env });
          return {
            start: async () => {
              const s = new EventEmitter();
              setTimeout(() => {
                s.emit('data', Buffer.concat([frame(1, stdout), ...(stderr ? [frame(2, stderr)] : [])]));
                s.emit('end');
              }, 0);
              return s;
            },
            inspect: async () => ({ ExitCode: exitCode }),
          };
        },
      }),
    },
  };
  return { docker: docker as never, calls };
}

const NOW = () => Date.parse('2026-10-24T12:00:00Z');

describe('readEdgeCerts', () => {
  it('no edge task on this node → edge:false, no exec', async () => {
    const f = fakeDocker([], '');
    expect(await readEdgeCerts(f.docker, NOW)).toEqual({ edge: false, certs: [], truncated: false, checkedAt: '2026-10-24T12:00:00.000Z' });
    expect(f.calls).toEqual([]);
  });

  it('runs the .crt-only loop inside the task and answers what parsed', async () => {
    const f = fakeDocker([{ Id: 'c1' }], `${TRUNCATED_MARK}\n`);
    const r = await readEdgeCerts(f.docker, NOW);
    expect(r).toEqual({ edge: true, certs: [], truncated: true, checkedAt: '2026-10-24T12:00:00.000Z' });
    expect(f.calls).toEqual([{ id: 'c1', cmd: edgeCertsExec().Cmd, env: edgeCertsExec().Env }]);
  });

  it('a failed loop is an error with its stderr', async () => {
    const f = fakeDocker([{ Id: 'c1' }], '', 2, 'sh: not found');
    await expect(readEdgeCerts(f.docker, NOW)).rejects.toThrow("reading the edge's certificates exited 2: sh: not found");
  });
});
