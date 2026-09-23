import { describe, expect, it } from 'bun:test';
import { writeFileExec } from './ingress-local';

describe('writeFileExec — in-task config delivery (replicated Caddy controller)', () => {
  it('carries the file as base64 env and decodes it to the target path via sh', () => {
    const contents = 'littleworld.example.test {\n\treverse_proxy littleworld_site:80\n}\n# "quotes" $vars `ticks`\n';
    const { Cmd, Env } = writeFileExec({ path: '/etc/caddy/Caddyfile', contents });
    expect(Cmd[0]).toBe('sh');
    expect(Cmd[2]).toContain('base64 -d > "$SWARMY_FILE_PATH"');
    expect(Env).toContain('SWARMY_FILE_PATH=/etc/caddy/Caddyfile');
    const b64 = Env.find((e) => e.startsWith('SWARMY_FILE_B64='))!.slice('SWARMY_FILE_B64='.length);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(contents);
    // Contents never appear raw in the shell command (no quoting/injection surface).
    expect(Cmd.join(' ')).not.toContain('reverse_proxy');
  });

  it('round-trips through a real shell', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/swarmy-ingress-local-${process.pid}`;
    const path = `${dir}/nested/Caddyfile`;
    const contents = 'a.test {\n\trespond "hi $HOME"\n}\n';
    const { Cmd, Env } = writeFileExec({ path, contents });
    const env = Object.fromEntries(Env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    const proc = Bun.spawn(Cmd, { env: { ...process.env, ...env } });
    expect(await proc.exited).toBe(0);
    expect(await Bun.file(path).text()).toBe(contents);
    await Bun.$`rm -rf ${dir}`.quiet();
  });
});

describe('localReload — writes then reloads inside THIS node\'s task (edge-per-node + controller)', () => {
  function fakeDocker(running: Array<{ Id: string }>) {
    const calls: Array<{ id: string; cmd: string[]; env?: string[] }> = [];
    const filters: unknown[] = [];
    const docker = {
      docker: {
        listContainers: async (opts: { filters: unknown }) => {
          filters.push(opts.filters);
          return running;
        },
        getContainer: (id: string) => ({
          exec: async (o: { Cmd: string[]; Env?: string[] }) => {
            calls.push({ id, cmd: o.Cmd, env: o.Env });
            return {
              start: async () => {
                const { EventEmitter } = await import('node:events');
                const s = new EventEmitter();
                setTimeout(() => s.emit('end'), 0);
                return s;
              },
              inspect: async () => ({ ExitCode: 0 }),
            };
          },
        }),
      },
    };
    return { docker, calls, filters };
  }

  it('targets the local task by swarm service label, writes the file, then runs caddy reload', async () => {
    const { localReload } = await import('./ingress-local');
    const { docker, calls, filters } = fakeDocker([{ Id: 'edge-task-1' }]);
    await localReload(
      docker as never,
      'swarmy-ingress-caddy',
      ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
      { path: '/etc/caddy/Caddyfile', contents: 'a.test {\n}\n' },
    );
    expect(filters[0]).toEqual({
      label: ['com.docker.swarm.service.name=swarmy-ingress-caddy'],
      status: ['running'],
    });
    expect(calls.map((c) => c.id)).toEqual(['edge-task-1', 'edge-task-1']);
    expect(calls[0]!.env).toContain('SWARMY_FILE_PATH=/etc/caddy/Caddyfile');
    expect(calls[1]!.cmd.slice(0, 2)).toEqual(['caddy', 'reload']);
  });

  it('no local task is an error, never a silent skip', async () => {
    const { localReload } = await import('./ingress-local');
    const { docker } = fakeDocker([]);
    await expect(localReload(docker as never, 'swarmy-ingress-caddy', ['caddy', 'reload'])).rejects.toThrow(
      /no running local task/,
    );
  });
});
