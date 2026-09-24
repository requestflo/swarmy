import { describe, expect, it } from 'bun:test';
import { REDACTED, redactConfigText, redactEnvEntry, redactEnvRecord, redactInspect, restoreRedactedEnv } from './secret-redact';

describe('secret redaction without secrets.read', () => {
  it('masks secret-looking env pairs and keeps the rest', () => {
    expect(redactEnvEntry('DATABASE_PASSWORD=hunter2')).toBe(`DATABASE_PASSWORD=${REDACTED}`);
    expect(redactEnvEntry('PORT=8080')).toBe('PORT=8080');
    expect(redactEnvEntry('NOTE=sk-ant-abcdefghijklmnopqrstuvwxyz')).toBe(`NOTE=${REDACTED}`);
  });

  it('masks every Env list inside a service inspect payload', () => {
    const inspect = {
      Spec: { TaskTemplate: { ContainerSpec: { Image: 'x', Env: ['API_TOKEN=abc123', 'LOG=debug'] } } },
      Other: [{ Env: ['SECRET_KEY=zzz'] }],
    };
    const out = redactInspect(inspect);
    expect(out.Spec.TaskTemplate.ContainerSpec.Env).toEqual([`API_TOKEN=${REDACTED}`, 'LOG=debug']);
    expect(out.Other[0]!.Env).toEqual([`SECRET_KEY=${REDACTED}`]);
    expect(inspect.Spec.TaskTemplate.ContainerSpec.Env[0]).toBe('API_TOKEN=abc123');
  });

  it('masks dotenv / yaml config lines and whole PEM keys', () => {
    const text = [
      'export DB_PASSWORD="p@ss"',
      'listen: 8080',
      'api_key: abcdef',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEow...',
      '-----END RSA PRIVATE KEY-----',
      'after=1',
    ].join('\n');
    const { text: out, redacted } = redactConfigText(text);
    expect(redacted).toBe(true);
    expect(out.split('\n')).toEqual([
      `export DB_PASSWORD=${REDACTED}`,
      'listen: 8080',
      `api_key: ${REDACTED}`,
      REDACTED,
      REDACTED,
      REDACTED,
      'after=1',
    ]);
    expect(redactConfigText('plain: true').redacted).toBe(false);
  });
});

describe('redactEnvRecord (services.get env for callers without secrets.read)', () => {
  it('masks secret-looking values, *_PASS included, and keeps the rest', () => {
    expect(
      redactEnvRecord({ PORT: '3000', REDIS_PASS: 'hunter2', SMTP_PASS: 'x', DATABASE_URL: 'postgres://u:pw@db/app', NODE_ENV: 'production' }),
    ).toEqual({ PORT: '3000', REDIS_PASS: REDACTED, SMTP_PASS: REDACTED, DATABASE_URL: REDACTED, NODE_ENV: 'production' });
  });
});

describe('restoreRedactedEnv (never deploy the mask back)', () => {
  it('swaps a masked plain value for the live one; leaves real edits and secrets alone', () => {
    const live = { REDIS_PASS: 'hunter2', PORT: '3000' };
    expect(
      restoreRedactedEnv(
        [
          { key: 'REDIS_PASS', value: REDACTED },
          { key: 'PORT', value: '4000' },
          { key: 'NEW', value: REDACTED },
          { key: 'TOKEN', value: REDACTED, secret: true },
        ],
        live,
      ),
    ).toEqual([
      { key: 'REDIS_PASS', value: 'hunter2' },
      { key: 'PORT', value: '4000' },
      { key: 'NEW', value: REDACTED },
      { key: 'TOKEN', value: REDACTED, secret: true },
    ]);
  });
});
