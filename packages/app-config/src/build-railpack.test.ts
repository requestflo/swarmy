import { describe, expect, it } from 'bun:test';
import { toDesired } from './desired';
import { parseAppConfig } from './parse';

const parse = (services: string) => parseAppConfig(`version: 1\napp: shop\nservices:\n${services}`);

describe('swarmy.yaml build: { type: railpack | dockerfile } (zero-config builds)', () => {
  it('Railpack overrides normalise into the build source; PORT follows port:', () => {
    const r = parse(`  web:
    build:
      type: railpack
      install: npm ci
      build: npm run build
      start: node dist/index.js
      packages: [node@22]
      apt: [ffmpeg]
      build_apt: [build-essential]
      env: { NEXT_PUBLIC_API: https://api.example.com, CI: true }
    port: 3000
`);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const web = toDesired(r.config!).services[0]!;
    expect(web.source).toMatchObject({
      kind: 'build',
      context: '.',
      builder: 'railpack',
      railpack: {
        installCmd: 'npm ci',
        buildCmd: 'npm run build',
        startCmd: 'node dist/index.js',
        packages: ['node@22'],
        deployAptPackages: ['ffmpeg'],
        buildAptPackages: ['build-essential'],
      },
      env: { NEXT_PUBLIC_API: 'https://api.example.com', CI: 'true' },
    });
    expect(web.env.PORT).toBe('3000');
  });

  it('a Railpack key without type implies railpack', () => {
    const web = toDesired(parse(`  web:\n    build: { start: "gunicorn app:app" }\n`).config!).services[0]!;
    expect(web.source).toMatchObject({ builder: 'railpack', railpack: { startCmd: 'gunicorn app:app' } });
  });

  it('no type and no Railpack keys stays auto — and the build key of an existing app does not move', () => {
    const plain = toDesired(parse(`  web:\n    build: .\n    port: 3000\n`).config!).services[0]!;
    expect(plain.source).not.toHaveProperty('builder');
    expect(plain.source).not.toHaveProperty('railpack');
    expect(plain.env.PORT).toBeUndefined();
    const obj = toDesired(parse(`  web:\n    build: { path: . }\n    port: 3000\n`).config!).services[0]!;
    expect(obj.source.kind === 'build' && plain.source.kind === 'build' && obj.source.key).toBe(
      plain.source.kind === 'build' ? plain.source.key : '',
    );
  });

  it('rejects mixing Dockerfile and Railpack settings', () => {
    const a = parse(`  web:\n    build: { type: dockerfile, start: "node x" }\n`);
    expect(a.config).toBeUndefined();
    expect(JSON.stringify(a.issues)).toContain('start is a Railpack setting');
    const b = parse(`  web:\n    build: { install: "npm ci", dockerfile: Dockerfile.prod }\n`);
    expect(JSON.stringify(b.issues)).toContain('dockerfile is a Dockerfile setting');
  });

  it('build-time env takes plain values, not deploy-time bindings', () => {
    const r = parse(`  web:\n    build: { type: railpack, env: { TOKEN: "\${{ secrets.npm }}" } }\n`);
    expect(r.config).toBeUndefined();
    expect(JSON.stringify(r.issues)).toContain('build-time env takes plain values');
  });
});
