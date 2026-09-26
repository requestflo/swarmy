import { describe, expect, it } from 'bun:test';
import {
  APP_SECRET_BY_LABEL,
  APP_SECRET_KEY_LABEL,
  APP_SECRET_ORG_LABEL,
  APP_SECRET_SERVICE_LABEL,
  APP_SECRET_VERSION_LABEL,
  appSecretLabels,
  appSecretName,
  appSecretsToPrune,
  applySecretVars,
  carrySecretVars,
  decodeAppSecrets,
  DOCKER_NAME_MAX,
  originalArgv,
  SECRET_ENV_ARGV_LABEL,
  SECRET_ENV_SHIM_CONFIG,
  SECRET_ENV_SHIM_PATH,
  SECRET_ENV_SHIM_SCRIPT,
  SECRET_ENV_VAR,
  SecretEnvError,
  unwrapSecretEnv,
  wrapSecretEnv,
  type AppSecretVersion,
} from './app-secrets';
import { toServiceCreateOptions } from './docker';
import { composeToModels } from './compose/from-compose';
import { composeToStack } from './compose/to-stack';
import { modelToComposeService } from './compose/to-compose';
import { looksSecret } from './dotenv';
import type { ServiceSpec } from './protocol/commands';

const VALUE = 'hunter2-very-secret-VALUE';
const VALUE_B64 = Buffer.from(VALUE).toString('base64');

/** Assert no form of the value appears anywhere in a rendered object. */
function expectNoValue(obj: unknown) {
  const json = JSON.stringify(obj);
  expect(json).not.toContain(VALUE);
  expect(json).not.toContain(VALUE_B64);
  expect(json).not.toContain(encodeURIComponent(VALUE));
}

const base: ServiceSpec = {
  name: 'shop_web',
  image: 'ghcr.io/acme/web:1.2.3',
  mode: { replicated: { replicas: 2 } },
  env: { LOG: 'debug', DB_PASSWORD: VALUE }, // a stale PLAIN copy that must be removed
  labels: { 'swarmy.managed': 'true', 'com.docker.stack.namespace': 'shop' },
  secrets: [{ source: 'tls__v1', target: 'tls' }],
  networks: ['shop_default'],
};

describe('appSecretName', () => {
  it('is <service>_<KEY>_v<N>', () => {
    expect(appSecretName('shop_web', 'DB_PASSWORD', 3)).toBe('shop_web_DB_PASSWORD_v3');
  });

  it('fits Docker’s 64-char cap and stays unique per (service, key)', () => {
    const svc = 'a-really-long-stack-name_with-a-really-long-service-name';
    const a = appSecretName(svc, 'STRIPE_SECRET_KEY_PRODUCTION', 12);
    const b = appSecretName(svc, 'STRIPE_SECRET_KEY_PRODUCTIOM', 12);
    expect(a.length).toBeLessThanOrEqual(DOCKER_NAME_MAX);
    expect(b.length).toBeLessThanOrEqual(DOCKER_NAME_MAX);
    expect(a).not.toBe(b);
    expect(a.endsWith('_v12')).toBe(true);
  });
});

describe('labels codec', () => {
  it('round-trips through decodeAppSecrets, org-scoped, newest first', () => {
    const rows = [1, 2].map((v) => ({
      name: appSecretName('shop_web', 'API_KEY', v),
      createdAt: v * 1000,
      labels: appSecretLabels({ service: 'shop_web', key: 'API_KEY', version: v, orgId: 'org1', by: 'Ada' }),
    }));
    rows.push({ name: 'other', createdAt: 0, labels: appSecretLabels({ service: 'x', key: 'K', version: 1, orgId: 'org2' }) });
    rows.push({ name: 'unmanaged', createdAt: 0, labels: {} as never });
    const out = decodeAppSecrets(rows, 'org1');
    expect(out.map((v) => [v.name, v.version, v.by])).toEqual([
      ['shop_web_API_KEY_v2', 2, 'Ada'],
      ['shop_web_API_KEY_v1', 1, 'Ada'],
    ]);
    const l = rows[0]!.labels;
    expect(l[APP_SECRET_SERVICE_LABEL]).toBe('shop_web');
    expect(l[APP_SECRET_KEY_LABEL]).toBe('API_KEY');
    expect(l[APP_SECRET_VERSION_LABEL]).toBe('1');
    expect(l[APP_SECRET_ORG_LABEL]).toBe('org1');
    expect(l[APP_SECRET_BY_LABEL]).toBe('Ada');
  });
});

describe('applySecretVars', () => {
  it('mounts at /run/secrets/<KEY>, env-delivers by default, drops the stale plain value', () => {
    const out = applySecretVars(
      base,
      [
        { key: 'DB_PASSWORD', delivery: 'env', secretName: 'shop_web_DB_PASSWORD_v1' },
        { key: 'TLS_KEY', delivery: 'file', secretName: 'shop_web_TLS_KEY_v4' },
      ],
      new Set(),
    );
    expect(out.secrets).toEqual([
      { source: 'tls__v1', target: 'tls' },
      { source: 'shop_web_DB_PASSWORD_v1', target: 'DB_PASSWORD', mode: 0o444 },
      { source: 'shop_web_TLS_KEY_v4', target: 'TLS_KEY', mode: 0o444 },
    ]);
    expect(out.secretEnv).toEqual(['DB_PASSWORD']);
    expect(out.env).toEqual({ LOG: 'debug', TLS_KEY_FILE: '/run/secrets/TLS_KEY' });
    expectNoValue(out);
  });

  it('rotation swaps the source, keeps the path; removal clears refs + _FILE + secretEnv', () => {
    const v1 = applySecretVars(
      base,
      [
        { key: 'DB_PASSWORD', delivery: 'env', secretName: 'shop_web_DB_PASSWORD_v1' },
        { key: 'TLS_KEY', delivery: 'file', secretName: 'shop_web_TLS_KEY_v1' },
      ],
      new Set(),
    );
    const managed = new Set(['shop_web_DB_PASSWORD_v1', 'shop_web_TLS_KEY_v1']);
    const v2 = applySecretVars(
      v1,
      [
        { key: 'DB_PASSWORD', delivery: 'env', secretName: 'shop_web_DB_PASSWORD_v2' },
        { key: 'TLS_KEY', delivery: 'file', secretName: 'shop_web_TLS_KEY_v1' },
      ],
      managed,
    );
    expect(v2.secrets).toContainEqual({ source: 'shop_web_DB_PASSWORD_v2', target: 'DB_PASSWORD', mode: 0o444 });
    expect(v2.secrets?.some((r) => r.source === 'shop_web_DB_PASSWORD_v1')).toBe(false);

    const removed = applySecretVars(v2, [], new Set([...managed, 'shop_web_DB_PASSWORD_v2']));
    expect(removed.secrets).toEqual([{ source: 'tls__v1', target: 'tls' }]);
    expect(removed.env).toEqual({ LOG: 'debug' });
    expect(removed.secretEnv).toBeUndefined();
  });
});

describe('secret-env shim wrap', () => {
  const desired = applySecretVars(
    base,
    [{ key: 'DB_PASSWORD', delivery: 'env', secretName: 'shop_web_DB_PASSWORD_v1' }],
    new Set(),
  );
  const image = { entrypoint: ['docker-entrypoint.sh'], cmd: ['node', 'server.js'] };

  it('runs /bin/sh <shim> <image entrypoint + cmd> with names only in env', () => {
    const w = wrapSecretEnv(desired, image);
    expect(w.command).toEqual(['/bin/sh', SECRET_ENV_SHIM_PATH]);
    expect(w.args).toEqual(['docker-entrypoint.sh', 'node', 'server.js']);
    expect(w.env?.[SECRET_ENV_VAR]).toBe('DB_PASSWORD');
    expect(w.env?.DB_PASSWORD).toBeUndefined();
    expect(w.configs).toEqual([{ source: SECRET_ENV_SHIM_CONFIG, target: SECRET_ENV_SHIM_PATH, mode: 0o444 }]);
    expect(w.secretEnv).toBeUndefined();
    expect(JSON.parse(w.labels![SECRET_ENV_ARGV_LABEL]!)).toEqual({ command: null, args: null });
  });

  it('follows Docker’s argv merge rules', () => {
    expect(originalArgv({ command: ['/app'], args: ['-v'] }, image)).toEqual(['/app', '-v']);
    expect(originalArgv({ command: ['/app'] }, image)).toEqual(['/app']); // entrypoint override drops CMD
    expect(originalArgv({ args: ['--port', '80'] }, image)).toEqual(['docker-entrypoint.sh', '--port', '80']);
    expect(() => originalArgv({}, null)).toThrow(SecretEnvError);
  });

  it('refuses a name with no mounted secret, and an image with nothing to exec', () => {
    expect(() => wrapSecretEnv({ ...desired, secretEnv: ['NOPE'] }, image)).toThrow(/no secret mounted/);
    expect(() => wrapSecretEnv(desired, { entrypoint: [], cmd: [] })).toThrow(/no ENTRYPOINT/);
  });

  it('unwrap restores the user’s own command/args + secretEnv; re-wrap is idempotent', () => {
    const custom = { ...desired, command: ['/app/server'], args: ['--port', '8080'] };
    const w = wrapSecretEnv(custom, null);
    const u = unwrapSecretEnv(w);
    expect(u.command).toEqual(['/app/server']);
    expect(u.args).toEqual(['--port', '8080']);
    expect(u.secretEnv).toEqual(['DB_PASSWORD']);
    expect(u.env?.[SECRET_ENV_VAR]).toBeUndefined();
    expect(u.configs).toBeUndefined();
    expect(u.labels?.[SECRET_ENV_ARGV_LABEL]).toBeUndefined();
    expect(wrapSecretEnv(w, null)).toEqual(w);
  });

  it('a spec without secretEnv is untouched (and never carries the field to Docker)', () => {
    const plain = { ...base, secretEnv: [] };
    const out = wrapSecretEnv(plain, null);
    expect(out).toEqual(base);
  });

  it('the shim is value-free, builtins-only POSIX sh that execs the original argv', () => {
    expect(SECRET_ENV_SHIM_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true);
    expect(SECRET_ENV_SHIM_SCRIPT).toContain('exec "$@"');
    expect(SECRET_ENV_SHIM_SCRIPT).toContain('unset IFS n f v l SWARMY_SECRET_ENV');
    expect(SECRET_ENV_SHIM_SCRIPT).not.toMatch(/\bcat\b|\becho "\$v|printenv|set -x/);
  });
});

/**
 * GOLDEN: a service with a secret variable, rendered all the way to the Docker
 * `createService` body the agent sends. The value must appear NOWHERE — not in
 * Env, Args, Labels or anywhere else — only the secret's NAME.
 */
describe('golden: rendered service spec carries no secret value', () => {
  const planned = applySecretVars(
    base,
    [
      { key: 'DB_PASSWORD', delivery: 'env', secretName: 'shop_web_DB_PASSWORD_v1' },
      { key: 'STRIPE_KEY', delivery: 'file', secretName: 'shop_web_STRIPE_KEY_v2' },
    ],
    new Set(),
  );
  const wrapped = wrapSecretEnv(planned, { entrypoint: ['docker-entrypoint.sh'], cmd: ['node', 'server.js'] });
  const body = toServiceCreateOptions(wrapped);

  it('matches the golden body', () => {
    expect(body).toEqual({
      Name: 'shop_web',
      Labels: {
        'swarmy.managed': 'true',
        'com.docker.stack.namespace': 'shop',
        [SECRET_ENV_ARGV_LABEL]: '{"command":null,"args":null}',
      },
      TaskTemplate: {
        ContainerSpec: {
          Image: 'ghcr.io/acme/web:1.2.3',
          Command: ['/bin/sh', '/run/swarmy/secret-env.sh'],
          Args: ['docker-entrypoint.sh', 'node', 'server.js'],
          Env: ['LOG=debug', 'STRIPE_KEY_FILE=/run/secrets/STRIPE_KEY', 'SWARMY_SECRET_ENV=DB_PASSWORD'],
          Mounts: undefined,
          Healthcheck: undefined,
          StopGracePeriod: undefined,
          Configs: [
            {
              ConfigName: 'swarmy_secret-env-shim_v1',
              File: { Name: '/run/swarmy/secret-env.sh', UID: '0', GID: '0', Mode: 0o444 },
            },
          ],
          Secrets: [
            { SecretName: 'tls__v1', File: { Name: 'tls', UID: '0', GID: '0', Mode: 0o444 } },
            { SecretName: 'shop_web_DB_PASSWORD_v1', File: { Name: 'DB_PASSWORD', UID: '0', GID: '0', Mode: 0o444 } },
            { SecretName: 'shop_web_STRIPE_KEY_v2', File: { Name: 'STRIPE_KEY', UID: '0', GID: '0', Mode: 0o444 } },
          ],
        },
        RestartPolicy: undefined,
        Resources: undefined,
        Placement: undefined,
        Networks: [{ Target: 'shop_default' }],
        LogDriver: { Name: 'json-file', Options: { 'max-size': '10m', 'max-file': '3' } },
      },
      Mode: { Replicated: { Replicas: 2 } },
      EndpointSpec: undefined,
    } as never);
  });

  it('no secret value anywhere in the planned, wrapped or rendered spec', () => {
    expectNoValue(planned);
    expectNoValue(wrapped);
    expectNoValue(body);
  });
});

describe('appSecretsToPrune (rotation GC)', () => {
  const H = 3_600_000;
  const now = 10 * H;
  const v = (key: string, version: number, createdAt: number): AppSecretVersion => ({
    name: appSecretName('shop_web', key, version),
    service: 'shop_web',
    key,
    version,
    createdAt,
    by: null,
    digest: null,
  });
  const versions = [v('DB', 1, 1 * H), v('DB', 2, 8 * H), v('OLD', 1, 1 * H)];

  it('removes superseded + unmounted versions once converged past the grace window', () => {
    const out = appSecretsToPrune(
      versions,
      [{ name: 'shop_web', secrets: ['shop_web_DB_v2'], converged: true, updatedAt: 8 * H }],
      now,
    );
    expect(out).toEqual(['shop_web_DB_v1', 'shop_web_OLD_v1']);
  });

  it('keeps everything while the rollout is in flight or inside the health-gate window', () => {
    const svc = { name: 'shop_web', secrets: ['shop_web_DB_v2'], converged: false, updatedAt: 8 * H };
    expect(appSecretsToPrune(versions, [svc], now)).toEqual([]);
    expect(appSecretsToPrune(versions, [{ ...svc, converged: true, updatedAt: now - 60_000 }], now)).toEqual([]);
    expect(
      appSecretsToPrune(versions, [{ ...svc, converged: true, updatedAt: now - 20 * 60_000, gateWindowSec: 3600 }], now),
    ).toEqual([]);
  });

  it('never removes a version any service still references (e.g. after a rollback)', () => {
    const out = appSecretsToPrune(
      versions,
      [{ name: 'shop_web', secrets: ['shop_web_DB_v1', 'shop_web_OLD_v1'], converged: true, updatedAt: 1 * H }],
      now,
    );
    expect(out).toEqual(['shop_web_DB_v2']);
  });

  it('a removed service keeps its newest version per key', () => {
    expect(appSecretsToPrune(versions, [], now)).toEqual(['shop_web_DB_v1']);
  });
});

describe('looksSecret (bulk .env paste marks likely secrets)', () => {
  it('flags key names and credential-shaped values, not public config', () => {
    expect(looksSecret('DATABASE_PASSWORD', 'x')).toBe(true);
    expect(looksSecret('OPENAI_API_KEY', 'x')).toBe(true);
    expect(looksSecret('DATABASE_URL', 'postgres://u:pw@db:5432/app')).toBe(true);
    expect(looksSecret('ANTHROPIC', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksSecret('SESSION', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc')).toBe(true);
    expect(looksSecret('NEXT_PUBLIC_API_KEY', 'pk_test_x')).toBe(false);
    expect(looksSecret('LOG_LEVEL', 'debug')).toBe(false);
  });
});

describe('the shim, executed', () => {
  it('exports each file byte-for-byte (trailing newlines kept), scrubs itself, execs argv', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'shim-'));
    writeFileSync(join(dir, 'A'), 'line1\nline2\n\n');
    writeFileSync(join(dir, 'B'), "q'uo\"te $HOME `x` no-newline");
    const script = join(dir, 'shim.sh');
    writeFileSync(script, SECRET_ENV_SHIM_SCRIPT.replaceAll('/run/secrets/', `${dir}/`));
    const probe = 'printf "%s|%s|%s" "$A" "$B" "${SWARMY_SECRET_ENV-unset}"';
    const run = Bun.spawnSync(['/bin/sh', script, '/bin/sh', '-c', probe], {
      env: { PATH: '/usr/bin:/bin', SWARMY_SECRET_ENV: 'A,B' },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("line1\nline2\n\n|q'uo\"te $HOME `x` no-newline|unset");

    const missing = Bun.spawnSync(['/bin/sh', script, '/bin/true'], {
      env: { PATH: '/usr/bin:/bin', SWARMY_SECRET_ENV: 'NOPE' },
    });
    expect(missing.exitCode).toBe(78);
    expect(missing.stderr.toString()).toContain('NOPE is not mounted');

    const bad = Bun.spawnSync(['/bin/sh', script, '/bin/true'], {
      env: { PATH: '/usr/bin:/bin', SWARMY_SECRET_ENV: 'X;rm' },
    });
    expect(bad.exitCode).toBe(78);
  });
});

describe('compose `x-swarmy-secret-env`', () => {
  const doc = {
    services: {
      api: {
        image: 'api:1',
        secrets: [{ source: 'db_password', target: 'DB_PASSWORD' }],
        'x-swarmy-secret-env': ['DB_PASSWORD'],
      },
    },
    secrets: { db_password: { external: true } },
  };

  it('maps to spec.secretEnv (no warning) and round-trips on export', () => {
    const { models, warnings } = composeToModels(doc);
    expect(warnings).toEqual([]);
    expect(models[0]!.secretEnv).toEqual(['DB_PASSWORD']);
    expect(modelToComposeService(models[0]!)).toMatchObject({ 'x-swarmy-secret-env': ['DB_PASSWORD'] });
    const plan = composeToStack(doc, 'shop');
    expect(plan.specs[0]!.secretEnv).toEqual(['DB_PASSWORD']);
    expect(plan.specs[0]!.secrets).toEqual([{ source: 'db_password', target: 'DB_PASSWORD' }]);
  });
});

describe('carrySecretVars (compose redeploy keeps dashboard-set secrets)', () => {
  const live = {
    name: 'shop_web',
    env: ['LOG=info', 'SWARMY_SECRET_ENV=DB_PASSWORD', 'TLS_KEY_FILE=/run/secrets/TLS_KEY'],
    secrets: ['shop_web_DB_PASSWORD_v3', 'shop_web_TLS_KEY_v1', 'unrelated'],
  };

  it('re-mounts env + file secret vars on the compose-built spec', () => {
    const out = carrySecretVars({ name: 'shop_web', image: 'web:2', env: { LOG: 'warn' } }, live);
    expect(out.secretEnv).toEqual(['DB_PASSWORD']);
    expect(out.env).toEqual({ LOG: 'warn', TLS_KEY_FILE: '/run/secrets/TLS_KEY' });
    expect(out.secrets?.map((r) => [r.source, r.target])).toEqual([
      ['shop_web_DB_PASSWORD_v3', 'DB_PASSWORD'],
      ['shop_web_TLS_KEY_v1', 'TLS_KEY'],
    ]);
  });

  it('the compose wins when it sets the key itself', () => {
    const out = carrySecretVars({ name: 'shop_web', image: 'web:2', env: { DB_PASSWORD: 'from-compose' } }, live);
    expect(out.secretEnv).toBeUndefined();
    expect(out.env?.DB_PASSWORD).toBe('from-compose');
    expect(out.secrets?.map((r) => r.target)).toEqual(['TLS_KEY']);
  });
});

describe('applySecretEnvFileFallback (shell-less images)', () => {
  it('allowed names become <NAME>_FILE; the rest are reported; unwrap restores the intent', async () => {
    const { applySecretEnvFileFallback, unwrapSecretEnv, SECRET_ENV_FILE_LABEL } = await import('./app-secrets');
    const spec: ServiceSpec = {
      name: 'a',
      image: 'distroless',
      env: { LOG: '1', DATABASE_URL: 'stale' },
      secrets: [{ source: 'u__v1', target: 'DATABASE_URL' }, { source: 'k__v1', target: 'API_KEY' }],
      secretEnv: ['DATABASE_URL', 'API_KEY'],
      secretEnvFileFallback: ['DATABASE_URL'],
    };
    const { spec: out, unresolved } = applySecretEnvFileFallback(spec);
    expect(unresolved).toEqual(['API_KEY']);
    expect(out.env).toEqual({ LOG: '1', DATABASE_URL_FILE: '/run/secrets/DATABASE_URL' });
    expect(out.labels?.[SECRET_ENV_FILE_LABEL]).toBe('DATABASE_URL');
    expect(out.secretEnvFileFallback).toBeUndefined();
    const back = unwrapSecretEnv({ ...out, secretEnv: undefined });
    expect(back.env).toEqual({ LOG: '1' });
    expect(back.secretEnv).toEqual(['DATABASE_URL']);
    expect(back.secretEnvFileFallback).toEqual(['DATABASE_URL']);
    expect(back.labels?.[SECRET_ENV_FILE_LABEL]).toBeUndefined();
  });
});
