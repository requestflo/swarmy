import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { helpText, parseArgs, parseDurationSeconds, UsageError, COMMANDS } from '../src/args';
import { parseDotenv, serializeDotenv } from '../src/dotenv';
import { planEnvPush } from '../src/commands/service';
import { deviceLogin } from '../src/commands/auth';
import { batchArtifacts, collectArtifacts } from '../src/commands/errors';
import { mkdir } from 'node:fs/promises';
import { makeCtx, type Io } from '../src/context';
import { main } from '../src/main';
import { fakeApi, serveFakeApi } from '@swarmy/devkit/testing';

describe('command parsing', () => {
  test('one- and two-word commands, flags, shorts, lists', () => {
    expect(parseArgs(['logs', 'web', '-f', '-n', '50'])).toEqual({
      command: 'logs',
      positionals: ['web'],
      flags: { follow: true, tail: '50' },
    });
    expect(parseArgs(['env', 'push', '.env.prod', '--secret', 'A,B', '--secret=C', '-y'])).toEqual({
      command: 'env push',
      positionals: ['.env.prod'],
      flags: { secret: ['A', 'B', 'C'], yes: true },
    });
    expect(parseArgs(['login', '--controller=https://ctl.example', '--scope', 'read,write']).flags).toEqual({
      controller: 'https://ctl.example',
      scope: ['read', 'write'],
    });
    expect(parseArgs(['logs', '-fn50']).flags).toEqual({ follow: true, tail: '50' });
    expect(parseArgs(['login', '--no-browser']).flags).toEqual({ 'no-browser': true });
  });

  test('bare `env` lists; no command is help; --version', () => {
    expect(parseArgs(['env']).command).toBe('env ls');
    expect(parseArgs(['env', '--service', 'web']).flags.service).toBe('web');
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
  });

  test('run passes its command’s own flags through', () => {
    expect(parseArgs(['run', '-s', 'web', '--', 'npm', 'test', '--watch'])).toEqual({
      command: 'run',
      positionals: ['npm', 'test', '--watch'],
      flags: { service: 'web' },
    });
    expect(parseArgs(['run', 'node', '-e', 'x']).positionals).toEqual(['node', '-e', 'x']);
  });

  test('errors are usage errors', () => {
    expect(() => parseArgs(['deploy', '--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['logs', '--tail'])).toThrow('--tail needs a value');
    expect(() => parseArgs(['deplyo'])).toThrow('unknown command "deplyo" (did you mean deploy?)');
    expect(() => parseArgs(['status', '--json=1'])).toThrow('takes no value');
  });

  test('sourcemaps upload and errors subcommands', () => {
    expect(parseArgs(['sourcemaps', 'upload', 'dist', '--app', 'shop', '--no-release', '--url-prefix', '~/static/', '--ext', 'js,map'])).toEqual({
      command: 'sourcemaps upload',
      positionals: ['dist'],
      flags: { app: 'shop', 'no-release': true, 'url-prefix': '~/static/', ext: ['js', 'map'] },
    });
    expect(parseArgs(['sourcemaps', 'upload', 'a.js', '-r', '1.2.3']).flags).toEqual({ release: '1.2.3' });
    expect(parseArgs(['errors', 'dsn', '--app', 'shop']).command).toBe('errors dsn');
    expect(parseArgs(['errors', 'rotate-key', '-y']).flags).toEqual({ yes: true });
  });

  test('durations', () => {
    expect(parseDurationSeconds('90')).toBe(90);
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('2h')).toBe(7200);
    expect(() => parseDurationSeconds('soon')).toThrow(UsageError);
  });

  test('every command has help', () => {
    for (const c of COMMANDS) expect(helpText(c.name)).toContain(c.usage);
    expect(helpText()).toContain('env pull');
  });
});

describe('.env handling', () => {
  test('round-trips quoting, comments, export and multi-line values', () => {
    const text = 'export A=1\n# c\nB="two words" # trailing\nC=\'x#y\'\nD="line1\\nline2"\nE=plain # note\n';
    expect(parseDotenv(text)).toEqual({ A: '1', B: 'two words', C: 'x#y', D: 'line1\nline2', E: 'plain' });
    const out = serializeDotenv([
      { key: 'A', value: 'has space' },
      { key: 'S', value: null, note: 'secret' },
    ]);
    expect(out).toBe('A="has space"\n# S=  (secret)\n');
    expect(parseDotenv(out)).toEqual({ A: 'has space' });
  });

  test('push plan: unchanged skipped, existing secrets stay secret, prune only plain', () => {
    const remote = {
      service_id: 's',
      service: 'shop_web',
      secrets_readable: false,
      vars: [
        { key: 'KEEP', value: 'same', secret: false, delivery: null, withheld: false, error: null },
        { key: 'OLD', value: 'x', secret: false, delivery: null, withheld: false, error: null },
        { key: 'DB_PASSWORD', value: null, secret: true, delivery: 'env' as const, withheld: true, error: null },
      ],
    };
    const plan = planEnvPush({ KEEP: 'same', NEW: 'v', DB_PASSWORD: 'p', TOKEN: 't' }, remote, { secretKeys: ['TOKEN'], prune: true });
    expect(plan).toEqual({ set: { NEW: 'v' }, secrets: { DB_PASSWORD: 'p', TOKEN: 't' }, unset: ['OLD'] });
  });
});

function memIo(stdin = ''): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s), stdin: async () => stdin, isTty: false };
}

describe('against a controller', () => {
  const api = fakeApi({ scopes: ['read'] });
  let srv: { url: string; stop: () => void };
  let dir: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    srv = serveFakeApi(api);
    dir = await mkdtemp(path.join(tmpdir(), 'swarmy-cli-'));
    process.env.SWARMY_CONFIG_DIR = path.join(dir, 'config');
    process.env.SWARMY_CREDENTIAL_STORE = 'file';
    delete process.env.SWARMY_API_KEY;
    delete process.env.SWARMY_CONTROLLER;
  });
  afterAll(() => {
    srv.stop();
    process.env = saved;
  });

  test('login --api-key stores the key in a mode-600 file and whoami reads it', async () => {
    const io = memIo();
    expect(await main(['login', '--controller', srv.url, '--api-key', 'swk_test'], io, dir)).toBe(0);
    expect(io.stdout.join('')).toContain('as dev@acme.test (admin; scopes: read)');
    const credFile = path.join(dir, 'config', 'credentials.json');
    expect((await stat(credFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credFile, 'utf8'))).toEqual({ [srv.url.replace('127.0.0.1', '127.0.0.1')]: 'swk_test' });
    const who = memIo();
    expect(await main(['whoami'], who, dir)).toBe(0);
    expect(who.stdout.join('\n')).toContain('scopes      read');
  });

  test('a bad key is refused and not stored', async () => {
    const io = memIo();
    expect(await main(['login', '--controller', srv.url, '--api-key', 'swk_wrong'], io, dir)).toBe(1);
    expect(io.stderr.join('')).toContain('rejected that key');
  });

  test('link, status, env pull (secrets withheld), and a 403 on a write', async () => {
    let io = memIo();
    expect(await main(['link', 'shop', '--service', 'web'], io, dir)).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, '.swarmy', 'link.json'), 'utf8'))).toMatchObject({ repoId: 'repo_1', service: 'web' });

    io = memIo();
    expect(await main(['status'], io, dir)).toBe(0);
    expect(io.stdout.join('\n')).toContain('○ shop_web');

    io = memIo();
    expect(await main(['env', 'pull'], io, dir)).toBe(0);
    const dotenv = await readFile(path.join(dir, '.env'), 'utf8');
    expect(dotenv).toContain('NODE_ENV=production');
    expect(dotenv).toContain('# STRIPE_KEY=');
    expect((await stat(path.join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(io.stdout.join('\n')).toContain('Withheld (secret): STRIPE_KEY');

    io = memIo();
    expect(await main(['env', 'pull', '--include-secrets', '--force'], io, dir)).toBe(2);
    expect(io.stderr.join('')).toContain('cannot read secrets');

    await writeFile(path.join(dir, '.env'), 'NODE_ENV=production\nLOG=debug\n');
    io = memIo();
    expect(await main(['env', 'push', '--yes'], io, dir)).toBe(3);
    expect(io.stderr.join('\n')).toContain('lacks "write" scope');

    io = memIo();
    expect(await main(['logs', '--tail', '5'], io, dir)).toBe(0);
    expect(io.stdout.join('\n')).toContain('! FATAL: JavaScript heap out of memory');
  });

  test('sourcemaps: collect, batch and upload; errors dsn', async () => {
    const dist = path.join(dir, 'dist');
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await mkdir(path.join(dist, 'node_modules'), { recursive: true });
    await writeFile(path.join(dist, 'assets', 'app.js'), 'x');
    await writeFile(path.join(dist, 'assets', 'app.js.map'), '{}');
    await writeFile(path.join(dist, 'index.html'), '<html>');
    await writeFile(path.join(dist, 'node_modules', 'dep.js'), 'x');
    const arts = await collectArtifacts(['dist'], { cwd: dir, urlPrefix: '~/', exts: ['js', 'map'] });
    expect(arts.map((a) => a.name)).toEqual(['~/assets/app.js', '~/assets/app.js.map']);
    const sized = [5, 5, 5, 20].map((size, i) => ({ name: `f${i}`, file: `f${i}`, size }));
    const { batches, tooBig } = batchArtifacts(sized, 10);
    expect(batches.map((b) => b.map((a) => a.name))).toEqual([['f0', 'f1'], ['f2']]);
    expect(tooBig.map((a) => a.name)).toEqual(['f3']);

    // Upload needs a write key: log in with one against a write-scoped fake.
    const rw = fakeApi({ scopes: ['read', 'write'], key: 'swk_rw' });
    const srv2 = serveFakeApi(rw);
    try {
      const io = memIo();
      const env = { SWARMY_API_KEY: 'swk_rw', SWARMY_CONTROLLER: srv2.url };
      Object.assign(process.env, env);
      expect(await main(['sourcemaps', 'upload', 'dist', '--app', 'shop', '--release', 'v1'], io, dir)).toBe(0);
      const up = rw.calls.find((c) => c.path.startsWith('/errors/v1/'))!;
      expect(up.path).toBe('/errors/v1/stacks/shop/releases/v1/files');
      expect(Object.keys(up.body as object)).toEqual(['~/assets/app.js', '~/assets/app.js.map']);
      expect(io.stdout.join('\n')).toContain('Uploaded 2 file(s) to shop for release v1.');
      const dsn = memIo();
      expect(await main(['errors', 'dsn', '--app', 'shop'], dsn, dir)).toBe(0);
      expect(dsn.stdout).toEqual(['https://k1@ctl.test/7']);
      const rot = memIo();
      expect(await main(['errors', 'rotate-key', '--app', 'shop', '--yes'], rot, dir)).toBe(0);
      expect(rot.stdout).toEqual(['https://k2@ctl.test/7']);

      // remove: no TTY and no --yes refuses; data kept by default; --delete-data asks for it (QA-078).
      const refused = memIo();
      expect(await main(['remove', '--app', 'shop'], refused, dir)).toBe(2);
      expect(rw.calls.some((c) => c.method === 'DELETE')).toBe(false);
      const kept = memIo();
      expect(await main(['remove', '--app', 'shop', '--yes'], kept, dir)).toBe(0);
      expect(rw.calls.filter((c) => c.method === 'DELETE').at(-1)!.path).toBe('/stacks/stk_1');
      expect(kept.stdout).toEqual(['Removed shop. Its data is kept (shop_data).']);
      const gone = memIo();
      expect(await main(['remove', '--app', 'shop', '--delete-data', '--yes'], gone, dir)).toBe(0);
      expect(rw.calls.filter((c) => c.method === 'DELETE').at(-1)!.path).toBe('/stacks/stk_1?delete_data=true');
      expect(gone.stdout).toEqual(['Removed shop and its data.']);
    } finally {
      delete process.env.SWARMY_API_KEY;
      delete process.env.SWARMY_CONTROLLER;
      srv2.stop();
    }
  });

  test('device login: polls through pending/slow_down to a key', async () => {
    const replies = [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: 'swk_new', token_type: 'Bearer', scope: 'read write' } },
    ];
    const seen: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${new URL(url).pathname}`);
      if (url.endsWith('/device/code')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ scope: 'read write' });
        return Response.json({
          device_code: 'dc',
          user_code: 'BCDF-GHJK',
          verification_uri: 'http://ctl/device',
          verification_uri_complete: 'http://ctl/device?code=BCDF-GHJK',
          expires_in: 600,
          interval: 5,
        });
      }
      const r = replies.shift()!;
      return Response.json(r.body, { status: r.status });
    }) as unknown as typeof fetch;
    const io = memIo();
    const ctx = makeCtx(parseArgs(['login', '--no-browser']), io, dir);
    const waits: number[] = [];
    const r = await deviceLogin(ctx, 'http://ctl', ['read', 'write'], { fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(r).toEqual({ key: 'swk_new', scopes: ['read', 'write'] });
    expect(waits).toEqual([5000, 5000, 10_000]);
    expect(io.stderr.join('\n')).toContain('BCDF-GHJK');
    expect(seen.filter((s) => s.endsWith('/device/token'))).toHaveLength(3);
  });
});
