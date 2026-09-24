import { describe, expect, it } from 'bun:test';
import { FULL_EXAMPLE, MINIMAL_EXAMPLE } from './examples';
import { parseAppConfig } from './parse';

const errors = (text: string) =>
  parseAppConfig(text)
    .issues.filter((i) => i.severity === 'error')
    .map(({ code, path, line, message }) => ({ code, path: path.join('.'), line, message }));

describe('parseAppConfig', () => {
  it('parses the minimal example clean', () => {
    const r = parseAppConfig(MINIMAL_EXAMPLE);
    expect(r.issues).toEqual([]);
    expect(r.config?.app).toBe('blog');
    expect(r.config?.resources).toEqual({ db: 'postgres' });
  });

  it('parses the full example with no errors and no warnings', () => {
    const r = parseAppConfig(FULL_EXAMPLE);
    expect(r.issues).toEqual([]);
    expect(Object.keys(r.config?.services ?? {})).toEqual(['web', 'worker', 'admin']);
  });

  it('reports YAML syntax errors with a line', () => {
    const r = parseAppConfig('version: 1\napp: x\nservices:\n  web: [unclosed\n');
    expect(r.config).toBeUndefined();
    expect(r.issues[0]?.code.startsWith('yaml/')).toBe(true);
    expect(r.issues[0]?.line).toBeGreaterThan(0);
  });

  it('rejects duplicate keys instead of last-wins', () => {
    const r = parseAppConfig(
      'version: 1\napp: x\napp: y\nservices: { web: { image: nginx:1.27 } }\n',
    );
    expect(r.config).toBeUndefined();
    expect(r.issues.some((i) => i.code === 'yaml/duplicate-key')).toBe(true);
  });

  it('locates schema errors at the offending node', () => {
    const text = [
      'version: 1',
      'app: shop',
      'services:',
      '  web:',
      '    image: nginx:1.27',
      '    port: 99999',
      '',
    ].join('\n');
    expect(errors(text)).toEqual([
      {
        code: 'schema/invalid',
        path: 'services.web.port',
        line: 6,
        message: 'Number must be less than or equal to 65535',
      },
    ]);
  });

  it('names unknown keys (typos) precisely', () => {
    const text =
      'version: 1\napp: shop\nservices:\n  web:\n    image: nginx:1.27\n    replica: 2\n';
    expect(errors(text)).toEqual([
      {
        code: 'schema/invalid',
        path: 'services.web.replica',
        line: 6,
        message: 'unknown key "replica"',
      },
    ]);
  });

  it('requires exactly one of build or image', () => {
    const text = 'version: 1\napp: shop\nservices:\n  web: { port: 80 }\n';
    expect(errors(text).map((e) => e.message)).toEqual(['set exactly one of build or image']);
  });

  it('reports the object branch of a build union, not a generic union error', () => {
    const text = 'version: 1\napp: shop\nservices:\n  web:\n    build: { path: ../outside }\n';
    expect(errors(text)).toEqual([
      {
        code: 'schema/invalid',
        path: 'services.web.build.path',
        line: 5,
        message: 'a path relative to the repo root (no leading / or ..)',
      },
    ]);
  });

  it('rejects an unknown resource type with the allowed list', () => {
    const text =
      'version: 1\napp: shop\nservices: { web: { image: nginx:1.27 } }\nresources:\n  db: { type: mysql }\n';
    expect(errors(text)[0]?.message).toBe(
      'type must be one of postgres, cache, queue, search, vector, bucket',
    );
  });

  it('runs semantic validation: unknown resource, bad field, missing port', () => {
    const text = [
      'version: 1',
      'app: shop',
      'services:',
      '  web:',
      '    image: nginx:1.27',
      '    env:',
      '      A: ${{ dbx.url }}',
      '      B: ${{ cache.uri }}',
      '      C: ${{ services.worker.url }}',
      '  worker: { image: busybox:1.36 }',
      'resources:',
      '  cache: { type: cache }',
      '',
    ].join('\n');
    expect(errors(text)).toEqual([
      {
        code: 'binding/unknown-resource',
        path: 'services.web.env.A',
        line: 7,
        message: 'no resource named "dbx" (in ${{ dbx.url }})',
      },
      {
        code: 'binding/unknown-field',
        path: 'services.web.env.B',
        line: 8,
        message: 'cache "cache" has no "uri" — use one of url, host, port, password, password_file',
      },
      {
        code: 'binding/no-port',
        path: 'services.web.env.C',
        line: 9,
        message: 'service "worker" has no port to address',
      },
    ]);
  });

  it('catches reserved names, collisions, duplicate domains, bad pgvector, orphan jobs', () => {
    const text = [
      'version: 1',
      'app: shop',
      'services:',
      '  app: { image: a:1, port: 80, domains: [shop.example.com] }',
      '  db: { image: b:1, port: 80, domains: [shop.example.com] }',
      'resources:',
      '  db: postgres',
      '  vec: { type: vector, engine: pgvector, on: cache }',
      '  cache: cache',
      'jobs:',
      '  nightly: { schedule: "0 1 * * *", run: echo hi }',
      '',
    ].join('\n');
    expect(errors(text).map((e) => `${e.code} @ ${e.path}`)).toEqual([
      'name/reserved @ services.app',
      'name/collision @ resources.db',
      'domain/duplicate @ services.db.domains.0',
      'vector/on-not-postgres @ resources.vec.on',
      'job/needs-service @ jobs.nightly',
    ]);
  });

  it('keeps warnings alongside a valid config', () => {
    const text = [
      'version: 1',
      'app: shop',
      'services:',
      '  web: { image: nginx, port: 80, sleep_after: 5m, env: { K: "sk=${{ secrets.stripe }}", K2: "${{ secrets.stripe }}" } }',
      'resources:',
      '  files: { type: bucket, access: public }',
      '',
    ].join('\n');
    const r = parseAppConfig(text);
    expect(r.config).toBeDefined();
    expect(r.issues.map((i) => `${i.severity} ${i.code}`)).toEqual([
      'warning binding/secret-in-env',
      'warning service/sleep-without-domain',
      'warning service/floating-tag',
      'warning bucket/public',
    ]);
  });

  it('refuses a non-mapping document and a wrong version', () => {
    expect(parseAppConfig('- a\n- b\n').issues[0]?.code).toBe('config/not-a-map');
    expect(errors('version: 2\napp: x\nservices: { web: { image: a:1 } }\n')[0]?.message).toBe(
      'version must be 1',
    );
  });
});
