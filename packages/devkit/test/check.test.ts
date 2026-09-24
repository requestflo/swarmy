import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FULL_EXAMPLE, MINIMAL_EXAMPLE, parseAppConfig } from '@swarmy/app-config';
import { checkRepo, detectStack, formatCheckReport, memoryRepoFs, nodeRepoFs, type CheckReport } from '../src/check';

const codes = (r: CheckReport) => r.issues.map((i) => `${i.severity}:${i.code}`);

// ── sample repos (inline, golden style) ──────────────────────────────────────

const nextApp = {
  'package.json': JSON.stringify({
    name: '@acme/storefront',
    engines: { node: '>=22' },
    scripts: { build: 'next build', start: 'next start' },
    dependencies: { next: '15.0.0', react: '19.0.0' },
  }),
  'package-lock.json': '{}',
  'app/page.tsx': 'export default () => null',
};

describe('check: sample repos', () => {
  test('Next.js repo, no swarmy.yaml → detected, suggests a config that parses clean', async () => {
    const r = await checkRepo(memoryRepoFs(nextApp));
    expect(r.mode).toBe('detected');
    expect(r.ok).toBe(true);
    expect(r.app).toBe('storefront');
    expect(r.services[0]).toMatchObject({ name: 'web', source: 'railpack', port: 3000 });
    expect(r.services[0]!.detected).toMatchObject({ provider: 'node', framework: 'Next.js', version: '22', packageManager: 'npm' });
    expect(r.suggestedConfig).toBeDefined();
    expect(parseAppConfig(r.suggestedConfig!).config?.app).toBe('storefront');
    expect(codes(r)).toContain('info:config/missing');
  });

  test('swarmy.yaml with a Dockerfile builds + managed Postgres', async () => {
    const r = await checkRepo(
      memoryRepoFs({ 'swarmy.yaml': MINIMAL_EXAMPLE, Dockerfile: 'FROM node:22\nCMD ["node","server.js"]' }),
    );
    expect(r.mode).toBe('swarmy.yaml');
    expect(r.ok).toBe(true);
    expect(r.app).toBe('blog');
    expect(r.stack).toBe('blog');
    expect(r.services).toEqual([
      expect.objectContaining({ name: 'web', source: 'dockerfile', dockerfile: 'Dockerfile', port: 3000, domains: ['blog.example.com'] }),
    ]);
    expect(r.resources).toEqual([expect.objectContaining({ name: 'db', type: 'postgres' })]);
    expect(r.routes).toEqual([{ host: 'blog.example.com', path: '/', service: 'web', port: 3000 }]);
    expect(r.plan.join('\n')).toContain('Route https://blog.example.com → web:3000');
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('swarmy.yaml errors carry the parser’s line numbers', async () => {
    const yaml = 'version: 1\napp: Bad_Name\nservices:\n  web:\n    image: nginx:1.27\n    port: 99999\n';
    const r = await checkRepo(memoryRepoFs({ 'swarmy.yaml': yaml }));
    expect(r.ok).toBe(false);
    const port = r.issues.find((i) => i.path === 'services.web.port');
    expect(port).toMatchObject({ severity: 'error', file: 'swarmy.yaml', line: 6 });
    expect(r.issues.find((i) => i.path === 'app')).toMatchObject({ line: 2 });
  });

  test('monorepo: missing build path and missing pinned Dockerfile are errors', async () => {
    const yaml = [
      'version: 1',
      'app: shop',
      'services:',
      '  api:',
      '    build: { path: services/api, dockerfile: Dockerfile.prod }',
      '    port: 8080',
      '  web:',
      '    build: services/web',
      '    port: 3000',
      '',
    ].join('\n');
    const r = await checkRepo(memoryRepoFs({ 'swarmy.yaml': yaml, 'services/api/main.go': 'package main' }));
    expect(codes(r)).toEqual(expect.arrayContaining(['error:build/missing-dockerfile', 'error:build/missing-context']));
    expect(r.ok).toBe(false);
  });

  test('build context with no Dockerfile falls back to Railpack detection (warning, not error)', async () => {
    const yaml = 'version: 1\napp: api\nservices:\n  api:\n    build: .\n    port: 8000\n';
    const r = await checkRepo(
      memoryRepoFs({ 'swarmy.yaml': yaml, 'pyproject.toml': '[project]\ndependencies = ["fastapi", "uvicorn"]\n', 'main.py': '' }),
    );
    expect(r.ok).toBe(true);
    expect(r.services[0]).toMatchObject({ source: 'railpack', detected: { provider: 'python', framework: 'FastAPI' } });
    expect(codes(r)).toContain('warning:build/railpack');
  });

  test('nothing buildable → error', async () => {
    const yaml = 'version: 1\napp: x\nservices:\n  web:\n    build: .\n';
    const r = await checkRepo(memoryRepoFs({ 'swarmy.yaml': yaml, 'README.md': '# hi' }));
    expect(codes(r)).toContain('error:build/undetectable');
  });

  test('unpinned image is a warning', async () => {
    const r = await checkRepo(memoryRepoFs({ 'swarmy.yaml': 'version: 1\napp: x\nservices:\n  web:\n    image: nginx\n' }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toContain('warning:image/unpinned');
  });

  test('the full example parses and plans every kind of unit', async () => {
    const files: Record<string, string> = { 'swarmy.yaml': FULL_EXAMPLE, 'services/orders/Dockerfile': 'FROM node:22' };
    const r = await checkRepo(memoryRepoFs(files));
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.resources.length).toBeGreaterThan(2);
    expect(r.jobs.length).toBeGreaterThan(0);
  });

  test('compose file: build-only services and Swarm-ignored keys are flagged', async () => {
    const compose = [
      'services:',
      '  web:',
      '    build: .',
      '    container_name: web',
      '    ports: ["8080:80"]',
      '  cache:',
      '    image: valkey/valkey:8',
      '    restart: always',
      '',
    ].join('\n');
    const r = await checkRepo(memoryRepoFs({ 'docker-compose.yml': compose }));
    expect(r.mode).toBe('compose');
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(
      expect.arrayContaining(['error:compose/build-only', 'warning:compose/ignored-key']),
    );
    expect(r.issues.filter((i) => i.code === 'compose/ignored-key').map((i) => i.path)).toEqual([
      'services.web.container_name',
      'services.cache.restart',
    ]);
  });

  test('an empty repo is undetectable', async () => {
    const r = await checkRepo(memoryRepoFs({ 'README.md': 'nothing' }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['error:repo/undetectable']);
  });

  test('explicit config path that does not exist', async () => {
    const r = await checkRepo(memoryRepoFs(nextApp), { configPath: 'deploy/swarmy.yaml' });
    expect(codes(r)).toEqual(['error:config/not-found']);
  });

  test('the report renders', async () => {
    const out = formatCheckReport(await checkRepo(memoryRepoFs({ 'swarmy.yaml': MINIMAL_EXAMPLE, Dockerfile: 'FROM x' })));
    expect(out).toContain('Found: swarmy.yaml (swarmy.yaml)');
    expect(out).toContain('What swarmy will do:');
    expect(out).toContain('✓ Ready for swarmy');
  });
});

describe('check: on disk', () => {
  test('reads a real directory and never escapes it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'swarmy-check-'));
    await mkdir(path.join(root, 'web'));
    await writeFile(path.join(root, 'go.mod'), 'module example.com/x\n\ngo 1.23\n');
    await writeFile(path.join(root, 'main.go'), 'package main');
    const fs = nodeRepoFs(root);
    expect(await fs.read('../etc/passwd')).toBeNull();
    expect(await fs.list('web')).toEqual([]);
    const r = await checkRepo(fs, { name: 'My Service' });
    expect(r.mode).toBe('detected');
    expect(r.app).toBe('my-service');
    expect(r.services[0]!.detected).toMatchObject({ provider: 'go', version: '1.23' });
  });
});

describe('detectStack', () => {
  const cases: Array<[string, Record<string, string>, Record<string, unknown> | null]> = [
    ['bun + hono', { 'package.json': JSON.stringify({ scripts: { start: 'bun src/index.ts' }, dependencies: { hono: '4' } }), 'bun.lock': '' }, { provider: 'node', framework: 'Hono', packageManager: 'bun', startCommand: 'bun start' }],
    ['vite static', { 'package.json': JSON.stringify({ devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }), 'pnpm-lock.yaml': '' }, { framework: 'Vite (static)', packageManager: 'pnpm' }],
    ['django', { 'requirements.txt': 'django\ngunicorn\n', 'manage.py': '' }, { provider: 'python', framework: 'Django', port: 8000 }],
    ['rails', { Gemfile: '', 'config/application.rb': '' }, { provider: 'ruby', framework: 'Rails' }],
    ['laravel', { 'composer.json': '{}', artisan: '' }, { provider: 'php', framework: 'Laravel' }],
    ['rust', { 'Cargo.toml': '' }, { provider: 'rust' }],
    ['static', { 'index.html': '<h1>hi</h1>' }, { provider: 'staticfile' }],
    ['nothing', { 'notes.txt': '' }, null],
  ];
  for (const [name, files, want] of cases) {
    test(name, async () => {
      const d = await detectStack(memoryRepoFs(files));
      if (want === null) expect(d).toBeNull();
      else expect(d).toMatchObject(want);
    });
  }

  test('node without a lockfile or start script warns', async () => {
    const d = await detectStack(memoryRepoFs({ 'package.json': JSON.stringify({ dependencies: { express: '4' } }) }));
    expect(d!.warnings.join(' ')).toContain('no lockfile');
    expect(d!.warnings.join(' ')).toContain('no "start" script');
  });
});
