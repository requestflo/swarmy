import { describe, expect, it } from 'bun:test';
import { detectBuild, detectProbePaths } from './detect-build';

// Manifests of the sample apps that were built for real with Railpack v0.40.0
// (their railpack prepare output is noted per case).
const NODE_EXPRESS = "{\n  \"name\": \"node-express-sample\",\n  \"version\": \"1.0.0\",\n  \"private\": true,\n  \"main\": \"index.js\",\n  \"scripts\": { \"start\": \"node index.js\" },\n  \"engines\": { \"node\": \"22\" },\n  \"dependencies\": { \"express\": \"^4.21.2\" }\n}\n";
const FLASK_REQS = "flask==3.1.0\ngunicorn==23.0.0\n";
const GO_MOD = "module example.com/gohttp\n\ngo 1.23\n";

describe('detectBuild (wizard preview of the Railpack plan)', () => {
  it('Node/Express (railpack: node 22.23.2, npm run start)', () => {
    expect(detectBuild({ 'package.json': NODE_EXPRESS, 'package-lock.json': '' })).toEqual({
      builder: 'railpack',
      provider: 'node',
      language: 'Node.js',
      framework: 'Express',
      runtime: 'Node 22',
      packageManager: 'npm',
      start: 'npm run start',
      port: 3000,
      healthPath: '/',
      summary: 'Express · Node 22 · start: npm run start',
    });
  });

  it('Next.js with pnpm + .nvmrc', () => {
    const d = detectBuild({
      'package.json': '{"scripts":{"build":"next build","start":"next start"},"dependencies":{"next":"15.0.0","react":"19"}}',
      'pnpm-lock.yaml': '',
      '.nvmrc': 'v20.11.0\n',
    });
    expect(d.summary).toBe('Next.js · Node 20 · start: pnpm start');
    expect(d.port).toBe(3000);
  });

  it('Vite SPA without a start script is served static by Caddy on :80', () => {
    const d = detectBuild({ 'package.json': '{"scripts":{"build":"vite build"},"devDependencies":{"vite":"6"}}' });
    expect(d).toMatchObject({ framework: 'Vite', port: 80, start: 'caddy (static build)' });
  });

  it('Python/Flask (railpack: python 3.13, gunicorn main:app on ${PORT:-8000})', () => {
    expect(detectBuild({ 'requirements.txt': FLASK_REQS, 'main.py': '' })).toMatchObject({
      provider: 'python',
      framework: 'Flask',
      start: 'gunicorn main:app',
      port: 8000,
      summary: 'Flask · start: gunicorn main:app',
    });
    expect(detectBuild({ 'pyproject.toml': '[project]\ndependencies = ["fastapi>=0.110", "uvicorn"]', 'uv.lock': '' })).toMatchObject({
      framework: 'FastAPI',
      packageManager: 'uv',
    });
    expect(detectBuild({ 'requirements.txt': 'Django==5.1\n', 'manage.py': '' }).framework).toBe('Django');
  });

  it('Go (railpack: go 1.23, ./out)', () => {
    expect(detectBuild({ 'go.mod': GO_MOD })).toMatchObject({ provider: 'golang', runtime: 'Go 1.23', start: './out', port: 8080 });
  });

  it('Ruby/Rails, PHP/Laravel, Rust', () => {
    expect(detectBuild({ Gemfile: "source 'https://rubygems.org'\nruby '3.3.4'\ngem 'rails', '~> 7.2'\n" })).toMatchObject({
      framework: 'Rails',
      runtime: 'Ruby 3.3',
      healthPath: '/up',
    });
    expect(detectBuild({ 'composer.json': '{"require":{"laravel/framework":"^11.0"}}', artisan: '' })).toMatchObject({
      framework: 'Laravel',
      port: 80,
    });
    expect(detectBuild({ 'Cargo.toml': '[package]\nname = "api"\n' })).toMatchObject({ provider: 'rust', start: './bin/api' });
  });

  it('static site (railpack: staticfile, caddy)', () => {
    expect(detectBuild({ 'index.html': '' })).toMatchObject({ provider: 'staticfile', port: 80, summary: 'Static site · start: caddy' });
  });

  it('a Dockerfile wins; nothing recognisable is flagged', () => {
    expect(detectBuild({ Dockerfile: 'FROM x', 'package.json': NODE_EXPRESS }).builder).toBe('dockerfile');
    expect(detectBuild({ 'README.md': '' })).toMatchObject({ builder: 'railpack', unknown: true });
  });

  it('works under a monorepo directory; truncated package.json still detects', () => {
    const { probePaths, presencePaths } = detectProbePaths('services/web/');
    expect(probePaths).toContain('services/web/package.json');
    expect(presencePaths).toContain('services/web/pnpm-lock.yaml');
    expect(detectProbePaths('').probePaths).toContain('package.json');
    const truncated = '{"name":"x","dependencies":{"next":"15","a":"' + 'x'.repeat(5000);
    expect(detectBuild({ 'services/web/package.json': truncated.slice(0, 4096) }, 'services/web').framework).toBe('Next.js');
  });
});
