import { describe, expect, it } from 'bun:test';
import type { DockerClient } from '@swarmy/core/docker';
import { COPY_KEY_LABEL, type RunOnceResult } from '@swarmy/core/protocol';
import { runCopyOnce } from './run-once-copy';
import { runOnce } from './swarmres';

/**
 * One copy container per `swarmy.copy.key` on a node: a controller restart
 * mid-preflight must not leave one copy running and start a second.
 */
const KEY = `ghcr.io/requestflo/swarmy-dns@sha256:${'a'.repeat(64)}`;
const frame = (s: string) => {
  const body = Buffer.from(s);
  const head = Buffer.alloc(8);
  head[0] = 1;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};

function fakeDocker(opts: { running?: string[]; wait?: () => Promise<unknown>; logs?: string } = {}) {
  const created: Array<{ Labels?: Record<string, string> }> = [];
  const removed: string[] = [];
  const filters: unknown[] = [];
  const docker = {
    pullImage: async () => '',
    docker: {
      listContainers: async (o: { filters?: unknown }) => {
        filters.push(o.filters);
        return (opts.running ?? []).map((Id) => ({ Id, State: 'running' }));
      },
      getImage: () => ({ inspect: async () => ({ Id: 'sha256:x' }) }),
      getContainer: (id: string) => ({
        wait: opts.wait ?? (async () => ({ StatusCode: 0 })),
        logs: async () => frame(opts.logs ?? ''),
        remove: async () => void removed.push(id),
      }),
      modem: { demuxStream: () => undefined },
      createContainer: async (o: { Labels?: Record<string, string> }) => {
        created.push(o);
        return { id: 'new', attach: async () => ({}), start: async () => undefined, wait: async () => ({ StatusCode: 0 }), remove: async () => undefined };
      },
    },
  } as unknown as DockerClient;
  return { docker, created, removed, filters };
}

const result = (output: string): RunOnceResult => ({ exitCode: 0, output });

describe('runOnce with a copyKey', () => {
  it('labels the copy container with its key; a plain one-shot gets no label', async () => {
    const f = fakeDocker();
    await runOnce(f.docker, { commandId: '00000000-0000-4000-8000-000000000001', image: 'regctl', pull: false, copyKey: KEY });
    await runOnce(f.docker, { commandId: '00000000-0000-4000-8000-000000000002', image: 'regctl', pull: false });
    expect(f.created.map((c) => c.Labels)).toEqual([{ [COPY_KEY_LABEL]: KEY }, undefined]);
    expect(f.filters).toEqual([{ label: [`${COPY_KEY_LABEL}=${KEY}`] }]);
  });
});

describe('runCopyOnce', () => {
  it('a second call for a key this process is still copying joins it (the controller restarted, the agent did not)', async () => {
    const f = fakeDocker();
    let release!: (r: RunOnceResult) => void;
    let starts = 0;
    const start = () => (starts++, new Promise<RunOnceResult>((r) => (release = r)));
    const flights = new Map<string, Promise<RunOnceResult>>();
    const first = runCopyOnce(f.docker, KEY, undefined, start, flights);
    await new Promise((r) => setTimeout(r, 0));
    const second = runCopyOnce(f.docker, KEY, undefined, start, flights);
    release(result('OK dns sha256:1'));
    expect(await first).toEqual(result('OK dns sha256:1'));
    expect(await second).toEqual({ ...result('OK dns sha256:1'), alreadyRunning: true });
    expect(starts).toBe(1);
    expect(flights.size).toBe(0);
  });

  it('waits on a running copy an earlier agent process started, reads its output back and removes it', async () => {
    const f = fakeDocker({ running: ['orphan'], logs: 'OK dns sha256:2\n' });
    const res = await runCopyOnce(f.docker, KEY, 60_000, async () => Promise.reject(new Error('must not start')), new Map());
    expect(res).toMatchObject({ exitCode: 0, output: 'OK dns sha256:2\n', alreadyRunning: true });
    expect(f.removed).toEqual(['orphan']);
  });

  it('reports it with empty output when the copy outlasts the budget (left running) or vanished first', async () => {
    const slow = fakeDocker({ running: ['orphan'], wait: () => new Promise(() => undefined) });
    const late = await runCopyOnce(slow.docker, KEY, 20, async () => result('x'), new Map());
    expect(late).toMatchObject({ output: '', timedOut: true, alreadyRunning: true });
    expect(slow.removed).toEqual([]);
    const gone = fakeDocker({ running: ['orphan'], wait: async () => Promise.reject(new Error('no such container')) });
    expect(await runCopyOnce(gone.docker, KEY, 1000, async () => result('x'), new Map())).toMatchObject({ output: '', alreadyRunning: true });
  });
});
