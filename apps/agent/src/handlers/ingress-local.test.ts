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
