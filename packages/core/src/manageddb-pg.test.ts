import { describe, expect, it } from 'bun:test';
import {
  MANAGED_PG_PGDATA,
  MANAGED_PG_ROOT,
  PG_ENV,
  applyPgBoot,
  pgBootCommand,
  pgBootRole,
  pgBootScript,
  pgPrimaryEnv,
  pgReplicaEnv,
  type PgBootSpecLike,
} from './manageddb-pg';
import { applyPgMember, type StorageSpecLike } from './manageddb-storage';

/**
 * The managed-Postgres boot layer (B5: official image + swarmy's entrypoint).
 * The script's behaviour was verified live against `pgvector/pgvector:pg17`
 * (primary → replica clone, restart, promote, promoted-writer restart under the
 * old replica spec, ex-primary rejoin with its data moved aside, timeline
 * follow after a repoint, PITR conf include, Bitnami-layout refusal); these
 * tests pin the load-bearing lines so a refactor cannot silently drop one.
 */

describe('pgBootScript — the swarmy entrypoint over the official image', () => {
  const s = pgBootScript();

  it('is valid POSIX sh', () => {
    const r = Bun.spawnSync(['sh', '-n'], { stdin: new TextEncoder().encode(s) });
    expect(r.exitCode).toBe(0);
  });

  it('ends by handing off to the OFFICIAL entrypoint (initdb, gosu drop)', () => {
    expect(s.trimEnd().endsWith('exec docker-entrypoint.sh postgres')).toBe(true);
    expect(s).toContain(`export PGDATA="\${PGDATA:-${MANAGED_PG_PGDATA}}"`);
  });

  it('first boot of a writer creates the replication role from env via psql variables', () => {
    expect(s).toContain('/docker-entrypoint-initdb.d/00-swarmy.sh');
    expect(s).toContain("SELECT format('CREATE ROLE %I WITH REPLICATION LOGIN PASSWORD %L', :'u', :'p')");
    expect(s).toContain('-v p="$SWARMY_PG_REPLICATION_PASSWORD"');
    expect(s).toContain("echo 'host replication all all scram-sha-256' >> \"$D/pg_hba.conf\"");
  });

  it('replicas clone into a side dir, verify PG_VERSION, then rename into place', () => {
    expect(s).toContain(
      'pg_basebackup -h "$PHOST" -p "$PPORT" -U "$RUSER" -w -D "$ROOT/pgdata.clone" -X stream -c fast',
    );
    expect(s).toContain('test -s "$ROOT/pgdata.clone/PG_VERSION"');
    expect(s).toContain('mv "$ROOT/pgdata.clone" "$PGDATA"');
    expect(s).toContain('touch "$PGDATA/standby.signal"');
  });

  it('the replication password reaches libpq via a container-local 0600 passfile, never argv or the volume', () => {
    expect(s).toContain('chmod 600 /var/run/postgresql/swarmy.pgpass');
    expect(s).toContain('passfile=/var/run/postgresql/swarmy.pgpass');
    expect(s).not.toMatch(/PGPASSWORD=/);
  });

  it('failover safety: a demoted ex-writer is moved ASIDE, never deleted; PGDATA is never rm -rf', () => {
    expect(s).toContain('ASIDE="$ROOT/pgdata.diverged-');
    expect(s).toContain('mv "$PGDATA" "$ASIDE"');
    expect(s).not.toContain('rm -rf "$PGDATA"');
    // Only failover-DRILL copies (a throwaway promotion) are pruned — to the latest one.
    expect(s).toContain('drill:*) rm -rf "$ROOT"/pgdata.drill-*;');
  });

  it('a promoted writer restarting under its old replica spec stays a writer (no new epoch)', () => {
    expect(s).toContain('[ "$(cat "$PGDATA/swarmy.rejoined" 2>/dev/null || true)" != "$EPOCH" ]');
    expect(s).toContain('starting as a writer');
  });

  it('never promotes at boot: no path removes standby.signal', () => {
    expect(s).not.toMatch(/rm -f[^\n]*standby\.signal/);
  });

  it('refuses to initdb an empty writer beside a pre-B5 Bitnami data dir', () => {
    expect(s).toContain('[ -s "$ROOT/data/PG_VERSION" ]');
    expect(s).toContain('exit 3');
  });

  it('includes swarmy.conf (primary_conninfo) and the conf dir the PITR config mounts into', () => {
    expect(s).toContain("include_if_exists 'swarmy.conf'");
    expect(s).toContain("include_dir '/etc/swarmy/postgresql.conf.d'");
    expect(s).toContain('primary_conninfo = \'host=$SWARMY_PG_PRIMARY_HOST');
    expect(s).toContain('chown postgres:postgres /wal-archive');
  });
});

describe('env contract', () => {
  it('primary: official POSTGRES_* + SWARMY_PG_* role/replication, fixed PGDATA', () => {
    const env = pgPrimaryEnv({ password: 'pw', database: 'app', replicationUser: 'repl', replicationPassword: 'rp' });
    expect(env).toEqual({
      SWARMY_PG_ROLE: 'primary',
      POSTGRES_PASSWORD: 'pw',
      POSTGRES_DB: 'app',
      PGDATA: MANAGED_PG_PGDATA,
      SWARMY_PG_REPLICATION_USER: 'repl',
      SWARMY_PG_REPLICATION_PASSWORD: 'rp',
    });
    expect(pgBootRole(env)).toBe('primary');
  });

  it('replica: points at the writer; a failover repoint adds the rejoin epoch', () => {
    const base = { password: 'pw', replicationUser: 'repl', replicationPassword: 'rp', primaryHost: 'h', primaryPort: 5432 };
    expect(pgReplicaEnv(base)[PG_ENV.rejoin]).toBeUndefined();
    const env = pgReplicaEnv({ ...base, rejoin: 'h@2026-01-01T00:00:00.000Z' });
    expect(env).toMatchObject({
      SWARMY_PG_ROLE: 'replica',
      SWARMY_PG_PRIMARY_HOST: 'h',
      SWARMY_PG_PRIMARY_PORT: '5432',
      SWARMY_PG_REJOIN: 'h@2026-01-01T00:00:00.000Z',
    });
    expect(pgBootRole(env)).toBe('replica');
  });
});

describe('applyPgBoot / applyPgMember — no rebuild can drop the entrypoint', () => {
  it('stamps the command, clears args, forces PGDATA', () => {
    const out = applyPgBoot({ command: ['x'], args: ['y'], env: { A: '1', PGDATA: '/elsewhere' } });
    expect(out.command).toEqual(pgBootCommand());
    expect(out.args).toBeUndefined();
    expect(out.env).toEqual({ A: '1', PGDATA: MANAGED_PG_PGDATA });
  });

  it('applyPgMember = storage from labels + boot layer, even on a bare inventory rebuild', () => {
    const bare: StorageSpecLike & PgBootSpecLike = { env: { POSTGRES_PASSWORD: 'pw' } };
    const out = applyPgMember(
      bare,
      { 'swarmy.db.dataVolume': 'v', 'swarmy.db.node': 'n1' },
    );
    expect(out.mounts).toEqual([{ type: 'volume', source: 'v', target: MANAGED_PG_ROOT }]);
    expect(out.placement).toEqual({ constraints: ['node.id==n1'], maxReplicasPerNode: 1 });
    expect(out.command).toEqual(pgBootCommand());
  });
});
