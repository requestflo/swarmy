import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOpenSshPublic, generateDeployKey, gitHost, isSshGitUrl } from './generic';
import {
  configPathsIn,
  InspectError,
  inspectEnv,
  parseInspectOutput,
  renderInspectProgram,
  validateInspectRequest,
} from './inspect';

const SHA = 'a'.repeat(40);
const has = (bin: string) =>
  spawnSync(bin, ['--version']).status === 0 || spawnSync(bin, ['-V']).status === 0;

describe('inspect program', () => {
  it('refuses refs and paths that could escape the shell or the repo', () => {
    const base = { url: 'https://x/y.git', paths: ['swarmy.yaml'] };
    expect(validateInspectRequest({ ...base, ref: 'main' })).toBeNull();
    expect(validateInspectRequest({ ...base, ref: SHA })).toBeNull();
    expect(validateInspectRequest({ ...base, ref: 'main; rm -rf /' })).toBe(
      'invalid ref "main; rm -rf /"',
    );
    expect(validateInspectRequest({ ...base, ref: 'a..b' })).toContain('invalid ref');
    expect(validateInspectRequest({ ...base, ref: 'main', paths: ['../etc/passwd'] })).toContain(
      'invalid path',
    );
    expect(validateInspectRequest({ ...base, ref: 'main', baseSha: 'HEAD~1' })).toBe(
      'invalid base sha',
    );
    expect(() => renderInspectProgram({ ...base, ref: '$(id)' })).toThrow();
  });

  it('keeps secrets out of the program text (env only)', () => {
    const req = {
      url: 'https://github.com/a/b.git',
      ref: 'main',
      paths: ['swarmy.yaml'],
      token: 'ghs_secret',
      sshKey: 'KEY',
    };
    expect(renderInspectProgram(req)).not.toContain('ghs_secret');
    expect(inspectEnv(req)).toEqual({
      GIT_URL: 'https://github.com/a/b.git',
      GIT_TOKEN: 'ghs_secret',
      GIT_USER: 'x-access-token',
      SWARMY_SSH_KEY: 'KEY',
    });
  });

  it('parses markers; a missing END means a truncated/failed run', () => {
    const out = [
      'SWARMY_BEGIN',
      `SWARMY_HEAD ${SHA}`,
      'SWARMY_CHANGED\tservices/orders/a.ts',
      'SWARMY_CHANGED_END',
      'SWARMY_TREE\tservices/orders/swarmy.yaml',
      'SWARMY_TREE\tservices/orders/Dockerfile',
      `SWARMY_FILE\tservices/orders/swarmy.yaml\t${Buffer.from('version: 1\n').toString('base64')}`,
      'SWARMY_NOFILE\tswarmy.yaml',
      'SWARMY_END',
    ].join('\n');
    expect(parseInspectOutput(out, ['services/orders/swarmy.yaml', 'swarmy.yaml'])).toEqual({
      sha: SHA,
      files: { 'services/orders/swarmy.yaml': 'version: 1\n', 'swarmy.yaml': null },
      tree: ['services/orders/swarmy.yaml', 'services/orders/Dockerfile'],
      changedPaths: ['services/orders/a.ts'],
    });
    expect(() => parseInspectOutput('SWARMY_BEGIN\nfatal: repository not found', [])).toThrow(
      InspectError,
    );
    expect(() => parseInspectOutput('fatal: repository not found', [])).toThrow(
      'could not read the commit: fatal: repository not found',
    );
    expect(
      parseInspectOutput(`SWARMY_BEGIN\nSWARMY_HEAD ${SHA}\nSWARMY_CHANGED_UNKNOWN\nSWARMY_END`, [])
        .changedPaths,
    ).toBeUndefined();
    expect(configPathsIn(['a/swarmy.yml', 'Dockerfile', 'swarmy.yaml'])).toEqual([
      'a/swarmy.yml',
      'swarmy.yaml',
    ]);
  });

  it.skipIf(!has('git'))(
    'runs for real against a local repo: file, tree, changed paths since base',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'swarmy-inspect-'));
      const repo = join(root, 'repo');
      mkdirSync(join(repo, 'services/orders'), { recursive: true });
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout.trim();
      };
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      // What GitHub/GitLab allow over the wire: partial clone + fetch-by-sha.
      git('config', 'uploadpack.allowFilter', 'true');
      git('config', 'uploadpack.allowAnySHA1InWant', 'true');
      writeFileSync(join(repo, 'services/orders/Dockerfile'), 'FROM scratch\n');
      writeFileSync(join(repo, 'README.md'), 'hi\n');
      git('add', '.');
      git('commit', '-q', '-m', 'one');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'services/orders/swarmy.yaml'), 'version: 1\napp: orders\n');
      writeFileSync(join(repo, 'services/orders/main.ts'), 'x\n');
      git('add', '.');
      git('commit', '-q', '-m', 'two');
      const head = git('rev-parse', 'HEAD');

      const req = {
        url: `file://${repo}`,
        ref: head,
        baseSha: base,
        paths: ['services/orders/swarmy.yaml', 'swarmy.yaml'],
      };
      const home = join(root, 'home');
      mkdirSync(home);
      const r = spawnSync('sh', ['-c', renderInspectProgram(req)], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: home, ...inspectEnv(req) },
      });
      const res = parseInspectOutput(`${r.stdout}\n${r.stderr}`, req.paths);
      expect(res).toEqual({
        sha: head,
        files: { 'services/orders/swarmy.yaml': 'version: 1\napp: orders\n', 'swarmy.yaml': null },
        tree: ['services/orders/Dockerfile', 'services/orders/swarmy.yaml'],
        changedPaths: ['services/orders/main.ts', 'services/orders/swarmy.yaml'],
      });
    },
  );
});

describe('deploy keys', () => {
  it('emits OpenSSH-format keys', () => {
    const k = generateDeployKey('swarmy@orders');
    expect(k.publicKey).toMatch(
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* swarmy@orders$/,
    );
    expect(k.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(k.privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(encodeOpenSshPublic(Buffer.alloc(32), 'c')).toBe(
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA c',
    );
  });

  it.skipIf(spawnSync('ssh-keygen', ['-?']).error !== undefined)(
    'ssh-keygen derives the same public key from the private key',
    () => {
      const k = generateDeployKey('swarmy');
      const dir = mkdtempSync(join(tmpdir(), 'swarmy-key-'));
      const f = join(dir, 'id');
      writeFileSync(f, k.privateKey, { mode: 0o600 });
      const r = spawnSync('ssh-keygen', ['-y', '-f', f], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.stdout.trim().split(' ').slice(0, 2)).toEqual(k.publicKey.split(' ').slice(0, 2));
      expect(readFileSync(f, 'utf8')).toBe(k.privateKey);
    },
  );

  it('recognises ssh URLs and hosts', () => {
    expect(isSshGitUrl('git@github.com:a/b.git')).toBe(true);
    expect(isSshGitUrl('ssh://git@host:2222/a/b.git')).toBe(true);
    expect(isSshGitUrl('https://github.com/a/b.git')).toBe(false);
    expect(gitHost('git@git.example.com:a/b.git')).toBe('git.example.com');
    expect(gitHost('https://gitlab.com/a/b')).toBe('gitlab.com');
  });
});
