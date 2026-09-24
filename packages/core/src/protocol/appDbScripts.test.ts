import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppDbBackupMsg,
  AppDbBackupPayload,
  AppDbCreds,
  AppDbRestoreMsg,
  AppDbRestorePayload,
  AppDbVerifyMsg,
} from './appDb';
import {
  KV_PLACE_SCRIPT,
  appDbRetentionTags,
  appDbTags,
  copySuffix,
  dumpScript,
  loadScript,
  parseProbeOutput,
  parseScriptOutputs,
  probeScript,
  redisArgHints,
  resolveAppDbCreds,
  scratchServerEnv,
  shq,
  verifyScript,
} from './appDbScripts';
import { ControllerToAgentMessage } from './messages';

const CID = '00000000-0000-4000-8000-000000000001';
const repo = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/b/p', password: 'pw' };
const creds = AppDbCreds.parse({ scope: 'root', user: [{ kind: 'literal', value: 'root' }], password: [{ kind: 'env', name: 'MYSQL_ROOT_PASSWORD' }], port: 3306 });

function redisCreds(): AppDbCreds {
  const r = resolveAppDbCreds('redis', ['REDIS_PASSWORD_FILE=/run/secrets/r']);
  if (!r.ok) throw new Error('unreachable');
  return r.creds;
}

function sh(script: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = spawnSync('/bin/sh', ['-c', script], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf8' });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

describe('appDb protocol messages (round-trip gate)', () => {
  it('parses a minimal backup payload with defaults', () => {
    const p = AppDbBackupPayload.parse({ commandId: CID, jobId: 'j', engine: 'mysql', service: 'wp_db', creds, repo, host: 'appdb-wp_db' });
    expect(p.tags).toEqual([]);
    expect(p.creds.database).toEqual([]);
    expect(AppDbBackupPayload.parse(p)).toEqual(p);
  });

  it('rejects an unknown engine, a shell-unsafe env name and a bad copy suffix', () => {
    const base = { commandId: CID, jobId: 'j', service: 's', creds, repo, host: 'h' };
    expect(AppDbBackupPayload.safeParse({ ...base, engine: 'postgres' }).success).toBe(false);
    expect(
      AppDbBackupPayload.safeParse({
        ...base,
        engine: 'mysql',
        creds: { ...creds, password: [{ kind: 'env', name: 'X;rm -rf /' }] },
      }).success,
    ).toBe(false);
    expect(
      AppDbRestorePayload.safeParse({
        commandId: CID, engine: 'mysql', mode: 'copy', service: 's', creds, repo, snapshotId: 'abc', suffix: "a'b",
      }).success,
    ).toBe(false);
  });

  it('wraps into the ControllerToAgentMessage union by type', () => {
    const backup = AppDbBackupMsg.parse({
      type: 'appDbBackup',
      payload: { commandId: CID, jobId: 'j', engine: 'mongo', service: 's', creds, repo, host: 'h' },
    });
    expect(ControllerToAgentMessage.parse(backup).type).toBe('appDbBackup');
    const restore = AppDbRestoreMsg.parse({
      type: 'appDbRestore',
      payload: { commandId: CID, engine: 'redis', mode: 'in-place', service: 's', creds, repo, snapshotId: 'x', suffix: 'copy_1' },
    });
    expect(ControllerToAgentMessage.parse(restore).type).toBe('appDbRestore');
    const verify = AppDbVerifyMsg.parse({
      type: 'appDbVerify',
      payload: { commandId: CID, engine: 'mariadb', image: 'mariadb:11', repo, snapshotId: 'x' },
    });
    expect(ControllerToAgentMessage.parse(verify).type).toBe('appDbVerify');
    expect(ControllerToAgentMessage.safeParse({ ...verify, type: 'appDbVerifyX' }).success).toBe(false);
  });
});

describe('resolveAppDbCreds (read the spec the way a human would)', () => {
  it('mysql root password from env', () => {
    const r = resolveAppDbCreds('mysql', ['MYSQL_ROOT_PASSWORD=s3cret', 'MYSQL_DATABASE=wp']);
    expect(r).toEqual({
      ok: true,
      note: null,
      creds: {
        scope: 'root',
        user: [{ kind: 'literal', value: 'root' }],
        password: [{ kind: 'env', name: 'MYSQL_ROOT_PASSWORD' }],
        database: [],
        authDb: [],
        port: 3306,
      },
    });
  });

  it('mariadb prefers MARIADB_* and follows _FILE secrets', () => {
    const r = resolveAppDbCreds('mariadb', [
      'MARIADB_ROOT_PASSWORD_FILE=/run/secrets/db_root',
      'MYSQL_ROOT_PASSWORD=legacy',
    ]);
    expect(r.ok && r.creds.password).toEqual([
      { kind: 'file', name: 'MARIADB_ROOT_PASSWORD_FILE' },
      { kind: 'env', name: 'MYSQL_ROOT_PASSWORD' },
    ]);
  });

  it('bitnami root user + port are honoured', () => {
    const r = resolveAppDbCreds('mariadb', ['MARIADB_ROOT_USER=admin', 'MARIADB_ROOT_PASSWORD=x', 'MARIADB_PORT_NUMBER=3307']);
    expect(r.ok && r.creds.user).toEqual([{ kind: 'env', name: 'MARIADB_ROOT_USER' }, { kind: 'literal', value: 'root' }]);
    expect(r.ok && r.creds.port).toBe(3307);
  });

  it('empty root password is resolvable; a random one without an app user is not', () => {
    const empty = resolveAppDbCreds('mysql', ['MYSQL_ALLOW_EMPTY_PASSWORD=yes']);
    expect(empty.ok && empty.creds.password).toEqual([]);
    expect(resolveAppDbCreds('mysql', ['MYSQL_RANDOM_ROOT_PASSWORD=1'])).toEqual({
      ok: false,
      reason: 'the root password is random and no MYSQL_USER/MYSQL_PASSWORD is set',
    });
    expect(resolveAppDbCreds('mysql', ['MYSQL_ALLOW_EMPTY_PASSWORD=no']).ok).toBe(false);
  });

  it('falls back to the app user scoped to its database', () => {
    const r = resolveAppDbCreds('mysql', ['MYSQL_RANDOM_ROOT_PASSWORD=1', 'MYSQL_USER=wp', 'MYSQL_PASSWORD_FILE=/run/secrets/wp', 'MYSQL_DATABASE=wordpress']);
    expect(r.ok && r.creds.scope).toBe('user');
    expect(r.ok && r.creds.database).toEqual([{ kind: 'env', name: 'MYSQL_DATABASE' }]);
    expect(r.ok && r.creds.password).toEqual([{ kind: 'file', name: 'MYSQL_PASSWORD_FILE' }]);
  });

  it('ignores a relative _FILE path and an empty value', () => {
    expect(resolveAppDbCreds('mysql', ['MYSQL_ROOT_PASSWORD_FILE=secrets/x', 'MYSQL_ROOT_PASSWORD=']).ok).toBe(false);
  });

  it('mongo: official root pair, bitnami root, app user, or no auth', () => {
    const off = resolveAppDbCreds('mongo', ['MONGO_INITDB_ROOT_USERNAME=root', 'MONGO_INITDB_ROOT_PASSWORD_FILE=/run/secrets/m']);
    expect(off.ok && off.creds).toEqual({
      scope: 'root',
      user: [{ kind: 'env', name: 'MONGO_INITDB_ROOT_USERNAME' }],
      password: [{ kind: 'file', name: 'MONGO_INITDB_ROOT_PASSWORD_FILE' }],
      database: [],
      authDb: [{ kind: 'literal', value: 'admin' }],
      port: 27017,
    });
    const bit = resolveAppDbCreds('mongo', ['MONGODB_ROOT_PASSWORD=x']);
    expect(bit.ok && bit.creds.user).toEqual([{ kind: 'literal', value: 'root' }]);
    const app = resolveAppDbCreds('mongo', ['MONGODB_USERNAME=u', 'MONGODB_PASSWORD=p', 'MONGODB_DATABASE=shop']);
    expect(app.ok && app.creds.authDb).toEqual([{ kind: 'env', name: 'MONGODB_DATABASE' }]);
    const none = resolveAppDbCreds('mongo', []);
    expect(none).toEqual({
      ok: true,
      note: 'no credentials in the service env — assumes auth is off',
      creds: { scope: 'none', user: [], password: [], database: [], authDb: [], port: 27017 },
    });
    expect(resolveAppDbCreds('mongo', ['MONGO_INITDB_ROOT_USERNAME=root']).ok).toBe(false);
  });

  it('redis/valkey always resolve: env password first, then the server command line', () => {
    const r = resolveAppDbCreds('valkey', ['VALKEY_PASSWORD=x']);
    expect(r.ok && r.creds.password).toEqual([{ kind: 'env', name: 'VALKEY_PASSWORD' }, { kind: 'redis-cmdline' }]);
    const plain = resolveAppDbCreds('redis', []);
    expect(plain.ok && plain.note).toBe('password (if any) read from the server command line / redis.conf');
  });
});

describe('probeScript (runs in-task; executed here under /bin/sh)', () => {
  it('resolves env, _FILE and literal sources in order and prints a trailer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appdb-'));
    const secret = join(dir, 'root');
    writeFileSync(secret, "p@ss 'w\"rd\n");
    const c = AppDbCreds.parse({
      scope: 'root',
      user: [{ kind: 'env', name: 'MYSQL_ROOT_USER' }, { kind: 'literal', value: 'root' }],
      password: [{ kind: 'env', name: 'MYSQL_ROOT_PASSWORD' }, { kind: 'file', name: 'MYSQL_ROOT_PASSWORD_FILE' }],
      port: 3306,
    });
    const r = sh(probeScript(c), { MYSQL_ROOT_PASSWORD_FILE: secret });
    expect(r.code).toBe(0);
    expect(parseProbeOutput(r.out)).toEqual({
      SWARMY_DB_USER: 'root',
      SWARMY_DB_PASSWORD: "p@ss 'w\"rd",
      SWARMY_DB_NAME: '',
      SWARMY_DB_AUTHDB: '',
      SWARMY_DB_PORT: '3306',
    });
  });

  it('a missing trailer is a failed probe, and unknown keys are dropped', () => {
    expect(() => parseProbeOutput('SWARMY_DB_USER=root\n')).toThrow('credential probe did not complete');
    expect(parseProbeOutput('PATH=/x\nSWARMY_DB_PORT=1\nSWARMY_PROBE_OK=1\n')).toEqual({ SWARMY_DB_PORT: '1' });
  });

  it('shq survives embedded quotes', () => {
    expect(sh(`printf %s ${shq("it's")}`).out).toBe("it's");
  });
});

describe('SQL copy-restore rename (executed with the real sed)', () => {
  const DUMP = [
    '-- MySQL dump 10.13',
    '/*!40000 DROP DATABASE IF EXISTS `wp`*/;',
    'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `wp` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
    'USE `wp`;',
    "INSERT INTO `posts` VALUES (1,'USE `wp`; is text');",
    '-- Dump completed on 2026-09-24',
    '',
  ].join('\n');

  it('renames only the database-level statements', () => {
    const script = loadScript('mysql');
    const sedLine = script.split('\n').find((l) => l.trim().startsWith('sed -e'))!.trim();
    const sedCmd = sedLine.slice(0, sedLine.indexOf(' /swarmy-dump/dump.sql'));
    const dir = mkdtempSync(join(tmpdir(), 'appdb-'));
    writeFileSync(join(dir, 'dump.sql'), DUMP);
    const r = sh(`${sedCmd} ${join(dir, 'dump.sql')}`, { SWARMY_SUFFIX: 'copy_202609241530' });
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        '-- MySQL dump 10.13',
        '/*!40000 DROP DATABASE IF EXISTS `wp_copy_202609241530`*/;',
        'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `wp_copy_202609241530` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
        'USE `wp_copy_202609241530`;',
        "INSERT INTO `posts` VALUES (1,'USE `wp`; is text');",
        '-- Dump completed on 2026-09-24',
        '',
      ].join('\n'),
    );
  });

  it('every script is valid POSIX sh (sh -n)', () => {
    for (const s of [
      dumpScript('mysql', 'root'),
      dumpScript('mariadb', 'user'),
      dumpScript('mongo', 'root'),
      dumpScript('redis', 'root'),
      loadScript('mariadb'),
      loadScript('mongo'),
      verifyScript('mysql'),
      verifyScript('mongo'),
      verifyScript('valkey'),
      probeScript(redisCreds()),
    ]) {
      const r = spawnSync('/bin/sh', ['-n', '-c', s], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
  });
});

describe('dump script goldens (the flags that make a dump consistent)', () => {
  it('mysql: single-transaction, routines, triggers; events only as root', () => {
    const root = dumpScript('mysql', 'root');
    expect(root).toContain(
      'OPTS="--single-transaction --routines --triggers --no-tablespaces --hex-blob --add-drop-database --events"',
    );
    expect(dumpScript('mysql', 'user')).toContain(
      'OPTS="--single-transaction --routines --triggers --no-tablespaces --hex-blob --add-drop-database"',
    );
    expect(root).toContain('DUMP=$(command -v mariadb-dump || command -v mysqldump || true)');
    expect(root).toContain('"$DUMP" --defaults-extra-file="$CNF" $OPTS --databases $DBS > /swarmy-dump/dump.sql');
    // credentials only ever on tmpfs
    expect(root).toContain('CNF=/dev/shm/swarmy-my.cnf');
    expect(root).not.toContain('-p"$');
  });

  it('mongo: an archive of every database, password via --config on tmpfs', () => {
    const s = dumpScript('mongo', 'root');
    expect(s).toContain('"$DUMP" "$@" --archive=/swarmy-dump/dump.archive');
    expect(s).toContain('set -- "$@" "--config=$CFG"');
  });

  it('redis: BGSAVE then copy the finished RDB off the data volume', () => {
    const s = dumpScript('redis', 'root');
    expect(s).toContain('out=$(r BGSAVE 2>&1 || true)');
    expect(s).toContain('cp "$dir/$file" /swarmy-dump/dump.rdb');
    expect(s).toContain('[ "$st" = ok ]');
  });

  it('mongo copy-restore renames namespaces; in-place drops first', () => {
    const s = loadScript('mongo');
    expect(s).toContain("'--nsFrom=$db$.$coll$' \"--nsTo=\\$db\\$_${SWARMY_SUFFIX}.\\$coll\\$\"");
    expect(s).toContain('"$RESTORE" "$@" --drop');
    expect(s).toContain("'--nsExclude=admin.*'");
  });
});

describe('script outputs, suffix, tags, scratch env', () => {
  it('parses repeated SWARMY_OUT keys', () => {
    expect(parseScriptOutputs('noise\nSWARMY_OUT db=a\nSWARMY_OUT db=b\r\nSWARMY_OUT tool=mysqldump\n')).toEqual({
      db: ['a', 'b'],
      tool: ['mysqldump'],
    });
  });

  it('copy suffix is UTC minutes', () => {
    expect(copySuffix(new Date('2026-09-24T15:30:59Z'))).toBe('copy_202609241530');
  });

  it('retention scope drops the reason tag', () => {
    const tags = appDbTags('o1', 'wp', 'wp_db', 'mariadb', 'pre-restore');
    expect(tags).toEqual(['org:o1', 'appdb:wp/wp_db', 'engine:mariadb', 'reason:pre-restore']);
    expect(appDbRetentionTags(tags)).toEqual(['org:o1', 'appdb:wp/wp_db', 'engine:mariadb']);
  });

  it('scratch servers get throwaway root creds (official + bitnami names)', () => {
    expect(scratchServerEnv('mariadb', 'x').server).toEqual(['MYSQL_ROOT_PASSWORD=x', 'MARIADB_ROOT_PASSWORD=x']);
    expect(scratchServerEnv('valkey', 'x').server).toContain('VALKEY_AOF_ENABLED=no');
  });

  it('the redis place script refuses a path escaping the volume', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appdb-'));
    writeFileSync(join(dir, 'rdbpath.txt'), '../etc/x\n');
    const r = sh(KV_PLACE_SCRIPT.replaceAll('/swarmy-dump', dir));
    expect(r.code).toBe(4);
    expect(readFileSync(join(dir, 'rdbpath.txt'), 'utf8')).toBe('../etc/x\n');
  });
});

describe('redisArgHints (redis rewrites its proc title, so read the configured argv)', () => {
  it('finds --requirepass in exec and sh -c forms, and a conf path', () => {
    expect(redisArgHints(['docker-entrypoint.sh', 'redis-server', '--requirepass', 'rpw', '--appendonly', 'yes'])).toEqual({ password: 'rpw' });
    expect(redisArgHints(['sh', '-c', 'redis-server /usr/local/etc/redis/redis.conf --requirepass "s3c"'])).toEqual({
      password: 's3c',
      conf: '/usr/local/etc/redis/redis.conf',
    });
    expect(redisArgHints(['redis-server'])).toEqual({});
  });
});
