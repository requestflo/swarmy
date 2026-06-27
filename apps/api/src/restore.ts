/**
 * Standalone controller restore (`bun run restore`).
 *
 * The disaster-recovery entrypoint: rebuild a controller from a controller-state
 * bundle + the user-held restore passphrase, WITH SWARMY NOT YET RUNNING. In a
 * real total-loss the dashboard is down, so this is a CLI, not a button.
 *
 * Flow (matches the epic's design doc):
 *   1. restic snapshots (controller-state) for the target → pick latest/chosen.
 *   2. restic restore + decrypt with the passphrase (zero-knowledge).
 *   3. read manifest.json, validate compatibility.
 *   4. restore SWARMY_SECRET_KEY / BETTER_AUTH_SECRET / config (write recovery env).
 *   5. bring up the DB schema (ensureSchema / migrate deploy).
 *   6. load the logical control-plane dump.
 * A restored controller re-adopts the swarm automatically — agent reconnect creds
 * are *hashed* per-node session secrets in the DB, so agents re-attach on dial-out.
 *
 * Target + passphrase come from flags/env (both live OUTSIDE the dead controller):
 *   --target-kind s3|node      (default s3)
 *   --endpoint, --bucket, --prefix, --region
 *   --access-key-id, --secret-access-key   (or AWS_* env)
 *   --restic-password <repo pw>            (or RESTIC_PASSWORD)
 *   --passphrase <restore passphrase>      (or SWARMY_RESTORE_PASSPHRASE)
 *   --snapshot <id|latest>                 (default latest)
 *   --write-env <path>                     (default ./.swarmy-restored.env)
 */
import { writeFile } from 'node:fs/promises';
import type { ResticRepo } from '@swarmy/core/protocol';
import { ensureSchema, buildAdapter, prisma } from '@swarmy/db';
import { restoreBundle, loadControlPlane } from '@swarmy/trpc';

interface Flags {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

function str(flags: Flags, key: string, env?: string, fallback?: string): string | undefined {
  const v = flags[key];
  if (typeof v === 'string') return v;
  if (env && process.env[env]) return process.env[env];
  return fallback;
}

function buildRepo(flags: Flags): ResticRepo {
  const kind = (str(flags, 'target-kind', undefined, 's3') as 's3' | 'node') ?? 's3';
  const endpoint = str(flags, 'endpoint');
  const bucket = str(flags, 'bucket');
  const prefix = str(flags, 'prefix');
  if (!bucket) throw new Error('--bucket is required (the restic repo bucket/path)');
  const prefixSeg = prefix ? `/${prefix.replace(/^\/+/, '')}` : '';
  const repoUrl =
    kind === 'node'
      ? `${bucket.replace(/\/+$/, '')}${prefixSeg}`
      : `s3:${(endpoint ?? '').replace(/\/+$/, '')}/${bucket}${prefixSeg}`;
  const password = str(flags, 'restic-password', 'RESTIC_PASSWORD');
  if (!password) throw new Error('--restic-password (or RESTIC_PASSWORD) is required');
  return {
    kind,
    repo: repoUrl,
    password,
    endpoint,
    region: str(flags, 'region', 'AWS_DEFAULT_REGION'),
    accessKeyId: str(flags, 'access-key-id', 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: str(flags, 'secret-access-key', 'AWS_SECRET_ACCESS_KEY'),
  };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  /* eslint-disable no-console */
  const log = (m: string) => console.log(`[restore] ${m}`);

  const passphrase = str(flags, 'passphrase', 'SWARMY_RESTORE_PASSPHRASE');
  if (!passphrase) {
    throw new Error('--passphrase (or SWARMY_RESTORE_PASSPHRASE) is required — the user-held restore key');
  }
  const repo = buildRepo(flags);
  const snapshotId = str(flags, 'snapshot', undefined, 'latest');

  log(`restoring controller-state bundle (${snapshotId}) from ${repo.repo} …`);
  const bundle = await restoreBundle({ repo, snapshotId, passphrase });
  log(
    `bundle decrypted: swarmy ${bundle.manifest.swarmyVersion}, db ${bundle.manifest.dbDriver}, ` +
      `${bundle.manifest.orgCount} orgs / ${bundle.manifest.nodeCount} nodes, taken ${bundle.manifest.createdAt}`,
  );

  // 4. recovery env — secrets the new controller must boot with.
  const envPath = str(flags, 'write-env', undefined, './.swarmy-restored.env')!;
  const envLines = [
    `SWARMY_SECRET_KEY=${bundle.secrets.SWARMY_SECRET_KEY}`,
    ...(bundle.secrets.BETTER_AUTH_SECRET ? [`BETTER_AUTH_SECRET=${bundle.secrets.BETTER_AUTH_SECRET}`] : []),
    ...Object.entries(bundle.secrets.config).map(([k, v]) => `${k}=${v}`),
  ];
  await writeFile(envPath, envLines.join('\n') + '\n', { mode: 0o600 });
  log(`wrote recovery secrets/config to ${envPath} (chmod 600). Source it before starting the controller.`);

  // The DB load needs SWARMY_SECRET_KEY in-process (rows carry encrypted refs).
  process.env.SWARMY_SECRET_KEY = bundle.secrets.SWARMY_SECRET_KEY;
  for (const [k, v] of Object.entries(bundle.secrets.config)) {
    if (v) process.env[k] = v;
  }

  // 5. bring up the schema. Lite mode self-migrates; server PG should be migrated
  //    with `prisma migrate deploy` first, but ensureSchema is a safe no-op when
  //    the schema is already present.
  log('ensuring schema (migrate) …');
  await ensureSchema(buildAdapter() as never);

  // 6. load the control-plane data.
  log('loading control-plane data …');
  await loadControlPlane(prisma, Buffer.from(bundle.dbDump).toString('utf8'));

  log('restore complete. Start the controller; agents re-adopt automatically.');
  await prisma.$disconnect?.();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`[restore] failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
