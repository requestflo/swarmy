import { describe, expect, it } from 'bun:test';
import {
  getDbTopology,
  injectConnection,
  migrateDbCredentials,
  provisionDb,
  readDbPassword,
  revealDbPassword,
  rotateDbPassword,
  rotateRolesScript,
} from './manageddb.service';
import { APP, CLUSTER, STACK, addApp, world } from './manageddb-testing';

/**
 * Security (owner decision): managed Postgres passwords are Docker SECRETS
 * (`<family>__v<n>`, mounted at `/run/secrets/<family>`), never spec env.
 * A small stateful fake swarm runs provision → inject → reveal → rotate and a
 * legacy migration, and after every step asserts that NO service spec (and no
 * one-shot payload) anywhere carries a plaintext DB password.
 */

describe('managed Postgres credentials are Docker secrets', () => {
  it('provision: the password is a secret file on every member; no spec carries it', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password: 'provisioned-secret-pw', autoBackup: false });
    expect(w.secrets.get('shop_main-pg-password__v1')).toBe('provisioned-secret-pw');
    for (const name of ['shop_main-primary', 'shop_main-replica']) {
      const s = w.services.get(name)!;
      expect(s.env).toContain('POSTGRES_PASSWORD_FILE=/run/secrets/shop_main-pg-password');
      expect(s.env).toContain('SWARMY_PG_REPLICATION_PASSWORD_FILE=/run/secrets/shop_main-pg-password');
      expect(s.env.some((e) => e.startsWith('POSTGRES_PASSWORD='))).toBe(false);
      expect(s.refs).toContainEqual({ source: 'shop_main-pg-password__v1', target: 'shop_main-pg-password' });
    }
    w.assertNowhere('provisioned-secret-pw');
  });

  it('reveal reads the mounted secret through exec (the secret-read path), audited', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 0, password: 'reveal-me-password', autoBackup: false });
    expect(await revealDbPassword(w.ctx, { stack: STACK, cluster: CLUSTER })).toEqual({ cluster: CLUSTER, password: 'reveal-me-password' });
    expect(w.execs).toContainEqual(['cat', '/run/secrets/shop_main-pg-password']);
  });

  it('inject: DATABASE_URL is a secret delivered as env; the app spec holds no password', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 0, password: 'inject-secret-pw', autoBackup: false });
    addApp(w);
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP });
    const app = w.services.get(APP)!;
    expect(app.refs).toContainEqual({ source: 'shop_main-pg-url__v1', target: 'DATABASE_URL' });
    expect(app.secretEnv).toEqual(['DATABASE_RO_URL', 'DATABASE_URL']);
    expect(w.secrets.get('shop_main-pg-url__v1')).toBe('postgres://postgres:inject-secret-pw@shop_main-primary:5432/app');
    w.assertNowhere('inject-secret-pw');
  });

  it('inject into a shell-less image: DATABASE_URL_FILE (the secret file), never plain env; dashboard notes it', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 0, password: 'distroless-secret-pw', autoBackup: false });
    addApp(w, { LOG: 'debug' }, {}, 'gcr.io/distroless/static:nonroot');
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP });
    const deployed = w.specsSeen.at(-1) as { secretEnvFileFallback?: string[] };
    expect(deployed.secretEnvFileFallback).toEqual(['DATABASE_RO_URL', 'DATABASE_URL']);
    const app = w.services.get(APP)!;
    expect(app.env).toContain('DATABASE_URL_FILE=/run/secrets/DATABASE_URL');
    expect(app.env).toContain('DATABASE_RO_URL_FILE=/run/secrets/DATABASE_RO_URL');
    expect(app.env.some((e) => e.startsWith('DATABASE_URL='))).toBe(false);
    expect(app.refs).toContainEqual({ source: 'shop_main-pg-url__v1', target: 'DATABASE_URL' });
    w.assertNowhere('distroless-secret-pw');
    const view = await getDbTopology(w.ctx, STACK);
    expect(view.clusters[0]?.fileDelivered).toEqual([{ service: APP, envVar: 'DATABASE_URL' }]);
  });

  it('rotate: new secret version, roles re-set from the new file, members + apps moved, old versions removed', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password: 'old-rotating-password', autoBackup: false });
    addApp(w);
    await injectConnection(w.ctx, { stack: STACK, cluster: CLUSTER, appService: APP });
    const res = await rotateDbPassword(w.ctx, { stack: STACK, cluster: CLUSTER }, { pollMs: 1, waitMs: 1000 });
    expect(res.version).toBe(2);
    const next = w.secrets.get('shop_main-pg-password__v2')!;
    expect(next).toBeDefined();
    expect(next).not.toBe('old-rotating-password');
    expect(w.roles).toEqual({ postgres: next, repl: next });
    for (const name of ['shop_main-primary', 'shop_main-replica']) {
      expect(w.services.get(name)!.refs).toContainEqual({ source: 'shop_main-pg-password__v2', target: 'shop_main-pg-password' });
    }
    expect(w.services.get(APP)!.refs).toContainEqual({ source: 'shop_main-pg-url__v2', target: 'DATABASE_URL' });
    expect(w.secrets.has('shop_main-pg-password__v1')).toBe(false);
    expect(w.secrets.has('shop_main-pg-url__v1')).toBe(false);
    // The ALTER never carries the value in argv.
    for (const cmd of w.execs) expect(cmd.join(' ')).not.toContain(next);
    w.assertNowhere('old-rotating-password');
    w.assertNowhere(next);
  });

  it('rotateRolesScript reads the new password from the file, never argv', () => {
    const s = rotateRolesScript('/run/secrets/shop_main-pg-password', 'repl');
    expect(s).toContain('\\set p `cat /run/secrets/shop_main-pg-password`');
    expect(s).toContain("ALTER ROLE %I PASSWORD %L', 'postgres', :'p'");
  });

  it('migration: a legacy plain-env cluster moves onto a secret in ONE update per member, apps too', async () => {
    const w = world();
    const legacyEnv = (role: string) => ({
      SWARMY_PG_ROLE: role,
      POSTGRES_PASSWORD: 'legacy-plain-password',
      POSTGRES_DB: 'app',
      SWARMY_PG_REPLICATION_USER: 'repl',
      SWARMY_PG_REPLICATION_PASSWORD: 'legacy-plain-password',
      ...(role === 'replica' ? { SWARMY_PG_PRIMARY_HOST: 'shop_main-primary' } : {}),
    });
    const member = (name: string, role: string, volume: string) => ({
      name,
      image: 'pgvector/pgvector:pg17',
      labels: {
        'com.docker.stack.namespace': STACK,
        'swarmy.db.cluster': CLUSTER,
        'swarmy.db.role': role,
        'swarmy.db.dataVolume': volume,
      },
      env: legacyEnv(role),
      networks: ['shop_main-net'],
      mounts: [{ type: 'volume', source: volume, target: '/var/lib/postgresql/data' }],
      command: ['/bin/sh', '-c', 'old boot script'],
    });
    w.put(member('shop_main-primary', 'primary', 'shop_main-primary-data'));
    w.put(member('shop_main-replica', 'replica', 'shop_main-replica-data'));
    addApp(
      w,
      { LOG: 'debug', DATABASE_URL: 'postgres://postgres:legacy-plain-password@shop_main-primary:5432/app' },
      { 'swarmy.db.inject': CLUSTER, 'swarmy.db.inject.var': 'DATABASE_URL' },
    );
    const deploysBefore = w.specsSeen.length;
    w.specsSeen.length = 0; // the legacy seed specs held the value by construction

    const res = await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(res.members).toEqual(['shop_main-primary', 'shop_main-replica']);
    expect(res.consumers).toEqual([APP]);
    expect(deploysBefore).toBe(3);
    // One deploy per member, one for the app.
    expect(w.specsSeen.map((s: any) => s.name)).toEqual(['shop_main-primary', 'shop_main-replica', APP]);
    expect(w.secrets.get('shop_main-pg-password__v1')).toBe('legacy-plain-password');
    const primary = w.services.get('shop_main-primary')!;
    expect(primary.labels['swarmy.db.passwordSecret']).toBe('shop_main-pg-password__v1');
    expect(primary.command?.[2]).toContain('SWARMY_PG_REPLICATION_PASSWORD_FILE'); // boot layer re-stamped
    expect(primary.mounts[0]?.source).toBe('shop_main-primary-data'); // data volume kept
    w.assertNowhere('legacy-plain-password');

    // Idempotent: a second tick changes nothing.
    const again = await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(again.members).toEqual([]);
    expect(again.consumers).toEqual([]);
    expect(await readDbPassword(w.ctx, STACK, CLUSTER)).toBe('legacy-plain-password');
  });

  it('QA-084b: members already migrated + an app still on plaintext DATABASE_URL* → one pass re-wires only the app', async () => {
    const w = world();
    await provisionDb(w.ctx, { stack: STACK, name: CLUSTER, replicas: 1, password: 'pre-upgrade-app-password', autoBackup: false });
    const plain = 'postgres://postgres:pre-upgrade-app-password@shop_main-primary:5432/app';
    addApp(
      w,
      { LOG: 'debug', DATABASE_URL: plain, DATABASE_RO_URL: plain.replace('primary', 'replica') },
      { 'swarmy.db.inject': CLUSTER, 'swarmy.db.inject.var': 'DATABASE_URL' },
    );
    w.specsSeen.length = 0; // the seeded legacy app spec held the value by construction
    const res = await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(res.members).toEqual([]); // members were migrated before
    expect(res.consumers).toEqual([APP]);
    const app = w.services.get(APP)!;
    expect(app.env.some((e) => e.startsWith('DATABASE_URL=') || e.startsWith('DATABASE_RO_URL='))).toBe(false);
    expect(app.refs).toContainEqual({ source: 'shop_main-pg-url__v1', target: 'DATABASE_URL' });
    expect(app.refs).toContainEqual({ source: 'shop_main-pg-ro-url__v1', target: 'DATABASE_RO_URL' });
    expect(app.secretEnv).toEqual(['DATABASE_RO_URL', 'DATABASE_URL']);
    w.assertNowhere('pre-upgrade-app-password');
    // Idempotent: the next pass finds nothing to do.
    expect((await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER })).consumers).toEqual([]);
  });

  it('QA-084b: an app is re-wired even while its writer cannot be touched (non-persistent storage)', async () => {
    const w = world();
    w.put({
      name: 'shop_main-primary',
      image: 'pg',
      labels: { 'com.docker.stack.namespace': STACK, 'swarmy.db.cluster': CLUSTER, 'swarmy.db.role': 'primary' },
      env: { POSTGRES_PASSWORD: 'anon-writer-password', POSTGRES_DB: 'app' },
      mounts: [],
    });
    addApp(
      w,
      { DATABASE_URL: 'postgres://postgres:anon-writer-password@shop_main-primary:5432/app' },
      { 'swarmy.db.inject': CLUSTER },
    );
    const res = await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER });
    expect(res.members).toEqual([]);
    expect(res.consumers).toEqual([APP]);
    expect(w.services.get(APP)!.env.some((e) => e.startsWith('DATABASE_URL='))).toBe(false);
    expect(w.services.get('shop_main-primary')!.gen).toBe(1); // the writer was never redeployed
  });

  it('migration never restarts a writer whose data is not on a persistent volume', async () => {
    const w = world();
    w.put({
      name: 'shop_main-primary',
      image: 'pg',
      labels: { 'com.docker.stack.namespace': STACK, 'swarmy.db.cluster': CLUSTER, 'swarmy.db.role': 'primary' },
      env: { POSTGRES_PASSWORD: 'anon-volume-password' },
      mounts: [],
    });
    const before = w.specsSeen.length;
    expect((await migrateDbCredentials(w.ctx, { stack: STACK, cluster: CLUSTER })).members).toEqual([]);
    expect(w.specsSeen.length).toBe(before);
  });
});
