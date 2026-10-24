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
 *   5. put the bundle's control.db snapshot in place (the controller must be
 *      stopped: it holds the file open), keeping any existing file beside it.
 *   6. bring the schema up to date (ensureSchema applies newer migrations).
 * A restored controller re-adopts the swarm automatically — agent reconnect creds
 * are *hashed* per-node session secrets in the DB, so agents re-attach on dial-out.
 *
 * The target comes from the swarm when it can: on a swarm manager, with
 * SWARMY_SECRET_KEY set (source state.env), the CLI reads where controller
 * backups go from the swarm-kv documents in raft (`restore-swarm.ts`), so a
 * controller that lost its volume still finds its backups. Every flag below
 * overrides that field; with nothing in the swarm the flags are the target:
 *   --target <id|name>         a destination other than the configured one
 *   --no-swarm-kv              don't read the swarm, use only the flags
 *   --target-kind s3|node      (default s3)
 *   --endpoint, --bucket, --prefix, --region
 *   --access-key-id, --secret-access-key   (or AWS_* env)
 *   --restic-password <repo pw>            (or RESTIC_PASSWORD)
 *   --passphrase <restore passphrase>      (or SWARMY_RESTORE_PASSPHRASE; always the user's)
 *   --snapshot <id|latest>                 (default latest)
 *   --write-env <path>                     (default ./.swarmy-restored.env)
 * Reading the swarm needs this host's Docker socket (DOCKER_HOST, else
 * /var/run/docker.sock) on a manager, e.g. `docker run --rm -v
 * /var/run/docker.sock:/var/run/docker.sock -v swarmy-data:/data …`.
 */
import { dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ensureSchema, buildAdapter, resolveDbPaths } from '@swarmy/db';
import { restoreBundle, installSnapshotFile, stashPendingKv } from '@swarmy/trpc';
import { buildRepo, parseArgs, str } from './restore-args';
import { targetFromSwarm } from './restore-swarm';

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  /* eslint-disable no-console */
  const log = (m: string) => console.log(`[restore] ${m}`);

  const passphrase = str(flags, 'passphrase', 'SWARMY_RESTORE_PASSPHRASE');
  if (!passphrase) {
    throw new Error('--passphrase (or SWARMY_RESTORE_PASSPHRASE) is required — the user-held restore key');
  }
  const fromSwarm = await targetFromSwarm(flags, log);
  const { repo, overridden } = buildRepo(flags, fromSwarm);
  if (fromSwarm && overridden.length) log(`flags override the swarm's ${overridden.join(', ')}`);
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

  // 5. put control.db in place. Run with the controller stopped.
  const path = resolveDbPaths().control;
  const { keptAs } = await installSnapshotFile(bundle.dbSnapshot, path);
  log(`wrote ${path}${keptAs ? ` (the previous file is kept as ${keptAs})` : ''}`);

  // 5b. infra config that lives in the swarm (swarm-kv). No hub in this
  // process: stash it next to control.db; the controller writes it into each
  // org's swarm once that org's manager agent connects (swarm-kv-restore).
  if (bundle.swarmKv?.orgs.length) {
    const file = await stashPendingKv(bundle.swarmKv, dirname(path));
    log(`queued swarm config for ${bundle.swarmKv.orgs.length} org(s) in ${file}`);
  }

  // 6. a bundle from an older swarmy gets the newer migrations now.
  const applied = await ensureSchema(buildAdapter());
  if (applied.length > 0) log(`applied ${applied.length} newer migration(s): ${applied.join(', ')}`);

  log('restore complete. Start the controller; agents re-adopt automatically.');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`[restore] failed:`, e instanceof Error ? e.message : e);
  process.exit(1);
});
