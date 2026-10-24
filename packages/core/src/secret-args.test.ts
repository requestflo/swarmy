import { describe, expect, it } from 'bun:test';
import { redactArgs, redactShellString } from './secret-args';

const M = '***';

describe('redactArgs (security review M3: credentials passed as flags)', () => {
  it('masks the value after a secret flag, and --flag=value', () => {
    expect(redactArgs(['redis-server', '--requirepass', 'hunter2', '--port', '6379'], M)).toEqual([
      'redis-server', '--requirepass', M, '--port', '6379',
    ]);
    expect(redactArgs(['--masterauth', 'pw', '--password=x', '--api-key=abc', '--dbpass', 'y'], M)).toEqual([
      '--masterauth', M, `--password=${M}`, `--api-key=${M}`, '--dbpass', M,
    ]);
    expect(redactArgs(['java', '-Djavax.net.ssl.keyStorePassword=changeit', '-jar', 'app.jar'], M)).toEqual([
      'java', `-Djavax.net.ssl.keyStorePassword=${M}`, '-jar', 'app.jar',
    ]);
  });

  it('knows redis-cli -a and mysql -p<pw>, and only for those tools', () => {
    expect(redactArgs(['CMD', 'redis-cli', '-a', 'hunter2', 'ping'], M)).toEqual(['CMD', 'redis-cli', '-a', M, 'ping']);
    expect(redactArgs(['mysqladmin', 'ping', '-uroot', '-phunter2'], M)).toEqual(['mysqladmin', 'ping', '-uroot', `-p${M}`]);
    expect(redactArgs(['tar', '-a', 'out.tgz'], M)).toEqual(['tar', '-a', 'out.tgz']);
    expect(redactArgs(['nginx', '-p', 'prefix'], M)).toEqual(['nginx', '-p', 'prefix']);
  });

  it('masks KEY=value pairs and value-shaped secrets; keeps refs, paths and boolean flags', () => {
    expect(redactArgs(['env', 'DB_PASSWORD=x', 'PORT=80', 'postgres://u:pw@db/app'], M)).toEqual([
      'env', `DB_PASSWORD=${M}`, 'PORT=80', M,
    ]);
    expect(redactArgs(['--requirepass', '$REDIS_PASSWORD', '--auth', '--bind_ip_all'], M)).toEqual([
      '--requirepass', '$REDIS_PASSWORD', '--auth', '--bind_ip_all',
    ]);
    expect(redactArgs(['--ssl-key', '/certs/key.pem', '--password'], M)).toEqual(['--ssl-key', '/certs/key.pem', '--password']);
  });

  it('judges a sh -c script word by word, and a spaced value after a flag as one word', () => {
    expect(redactArgs(['sh', '-c', 'exec redis-server --requirepass "s3cr3t" --appendonly yes'], M)).toEqual([
      'sh', '-c', `exec redis-server --requirepass ${M} --appendonly yes`,
    ]);
    expect(redactArgs(['--requirepass', 'two words'], M)).toEqual(['--requirepass', M]);
    expect(redactArgs(['CMD-SHELL', 'redis-cli -a pw ping || exit 1'], M)).toEqual(['CMD-SHELL', `redis-cli -a ${M} ping || exit 1`]);
  });

  it('keeps whitespace and unrelated words of a shell string exactly', () => {
    expect(redactShellString('  echo  hi   --token=abc  ', M)).toBe(`  echo  hi   --token=${M}  `);
    expect(redactShellString('nginx -g "daemon off;"', M)).toBe('nginx -g "daemon off;"');
  });
});
