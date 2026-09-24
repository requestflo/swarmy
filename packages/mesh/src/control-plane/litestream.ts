/**
 * Litestream (v0.5.x) config for the self-hosted NetBird control plane's
 * SQLite files (plan §2.5): `store.db`, `idp.db` and `events.db`, each to its
 * own replica path (v0.5 takes ONE replica per DB, and two writers on one path
 * can make it unrestorable).
 *
 * Pure and multi-DB so the controller store can share it later (it takes a
 * list of dbs + a socket path, as the controller-store agent asked). The same
 * settings as the controller's (apps/api/src/controller-store/litestream.ts):
 * 1 s sync, v0.5 checkpoint defaults spelled out, JSON logs on stderr, the
 * control socket on. Credentials never appear here: they ride the sidecar's
 * env as LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY.
 */

/** Pinned to the controller's version (apps/api/src/controller-store/litestream.ts). */
export const LITESTREAM_VERSION = '0.5.17';
export const LITESTREAM_IMAGE = `litestream/litestream:${LITESTREAM_VERSION}`;

export interface LitestreamReplica {
  bucket: string;
  /** Object prefix for this one DB (e.g. `<clusterId>/netbird/store`). */
  path: string;
  endpoint: string;
  region: string;
  skipVerify?: boolean;
}

export interface LitestreamDb {
  path: string;
  replica: LitestreamReplica;
}

export function renderLitestreamConfig(input: { dbs: LitestreamDb[]; socketPath: string }): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    '# Rendered by swarmy (packages/mesh litestream.ts). Credentials are in the env, never here.',
    'logging:',
    '  level: info',
    '  type: json',
    '  stderr: true',
    'socket:',
    '  enabled: true',
    `  path: ${q(input.socketPath)}`,
    'shutdown-sync-timeout: 20s',
    'dbs:',
  ];
  const dbs = [...input.dbs].sort((a, b) => (a.path < b.path ? -1 : 1));
  const seen = new Set<string>();
  for (const db of dbs) {
    const key = `${db.replica.bucket}/${db.replica.path}`;
    if (seen.has(key)) throw new Error(`two DBs share the replica path ${key}`);
    seen.add(key);
    lines.push(
      `  - path: ${q(db.path)}`,
      '    checkpoint-interval: 1m',
      '    min-checkpoint-page-count: 1000',
      '    busy-timeout: 1s',
      '    replica:',
      '      type: s3',
      `      bucket: ${q(db.replica.bucket)}`,
      `      path: ${q(db.replica.path)}`,
      `      endpoint: ${q(db.replica.endpoint)}`,
      `      region: ${q(db.replica.region)}`,
      '      force-path-style: true',
      '      sync-interval: 1s',
      ...(db.replica.skipVerify ? ['      skip-verify: true'] : []),
    );
  }
  return lines.join('\n') + '\n';
}

/** The NetBird control plane's SQLite files (under its data dir). */
export const NETBIRD_DB_FILES = ['store.db', 'idp.db', 'events.db'] as const;

/** One replica path per NetBird DB: `<prefix>/<name>` (`store.db` → `…/store`). */
export function netbirdLitestreamDbs(args: {
  dataDir: string;
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
}): LitestreamDb[] {
  const dir = args.dataDir.replace(/\/+$/, '');
  const prefix = args.prefix.replace(/^\/+|\/+$/g, '');
  return NETBIRD_DB_FILES.map((f) => ({
    path: `${dir}/${f}`,
    replica: {
      bucket: args.bucket,
      path: `${prefix}/${f.replace(/\.db$/, '')}`,
      endpoint: args.endpoint,
      region: args.region,
    },
  }));
}
