import { describe, expect, it } from 'bun:test';
import { REDACTED, redactConfigText, redactEnvEntry, redactInspect } from './secret-redact';

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
