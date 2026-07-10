/**
 * `swarmy-agent backup …` — rescue backups that work with the controller DARK.
 *
 * The normal backup path is controller-driven: repo credentials arrive over
 * the authenticated WS per command and never touch disk. When a node is cut
 * off, that path is gone — these commands are the escape hatch:
 *
 *   backup export  --stack X | --volumes a,b  [--to FILE] [--stop] [--yes]
 *       Tarball of the stack's named volumes + a manifest. Zero credentials.
 *       Stack/volume discovery is pure Docker labels — fully offline.
 *   backup restore --from FILE [--force] [--yes]
 *       Recreate the volumes from an export on this (or a replacement) node.
 *   backup push    --stack X | --volumes a,b  --repo s3:…  [--tag t]
 *       Straight to restic with operator-supplied credentials (env or prompt,
 *       never argv). Reuses the same sidecar machinery as controller backups.
 *   backup list    --from DIR | --repo s3:…
 *       Inspect local exports, or snapshots in a repo.
 *
 * Data always moves through short-lived sidecar containers with the volumes
 * bind-mounted, so any volume driver works and nothing new touches disk.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DockerClient } from '@swarmy/core/docker';
import { DEFAULT_RESTIC_IMAGE, type ResticRepo, type ResticSnapshotInfo } from '@swarmy/core/protocol';
import { ensureRepo, repoEnv, runSidecar, parseSummary } from '../handlers/backup';
import { env } from '../env';
import { versionInfo } from '../version';
import { confirmYesNo, fail, fmt, say } from './context';

const STACK_LABEL = 'com.docker.stack.namespace';
const TAR_IMAGE = 'alpine:3.20';

interface ExportManifest {
  kind: 'swarmy-rescue-export';
  createdAt: string;
  hostname: string;
  agentVersion: string;
  stack: string | null;
  volumes: { name: string; driver: string; labels: Record<string, string> }[];
}

export async function backupCommand(argv: string[], flags: Set<string>, options: Map<string, string>): Promise<void> {
  const sub = argv[0];
  const docker = new DockerClient(env.DOCKER_SOCKET);
  switch (sub) {
    case 'export':
      return backupExport(docker, flags, options);
    case 'restore':
      return backupRestore(docker, flags, options);
    case 'push':
      return backupPush(docker, options);
    case 'list':
      return backupList(docker, options);
    default:
      fail('usage: swarmy-agent backup <export|restore|push|list> — see `swarmy-agent help`');
  }
}

// ── volume discovery (offline: labels only) ─────────────────────────────────

async function resolveVolumes(
  docker: DockerClient,
  flags: { stack?: string; volumes?: string },
): Promise<{ stack: string | null; volumes: { name: string; driver: string; labels: Record<string, string> }[] }> {
  const d = docker.docker;
  if (flags.volumes) {
    const names = flags.volumes.split(',').map((v) => v.trim()).filter(Boolean);
    const volumes = [];
    for (const name of names) {
      const info = (await d.getVolume(name).inspect().catch(() => null)) as {
        Name: string;
        Driver: string;
        Labels: Record<string, string> | null;
      } | null;
      if (!info) fail(`volume "${name}" does not exist on this node`);
      volumes.push({ name: info.Name, driver: info.Driver, labels: info.Labels ?? {} });
    }
    return { stack: flags.stack ?? null, volumes };
  }

  if (!flags.stack) fail('pass --stack <name> or --volumes <a,b,…>');
  const stack = flags.stack;

  // Union of (a) volumes labeled with the stack namespace and (b) volumes
  // mounted by the stack's containers (covers pre-existing/external volumes).
  const listed = (await d.listVolumes({ filters: { label: [`${STACK_LABEL}=${stack}`] } })) as {
    Volumes?: { Name: string; Driver: string; Labels: Record<string, string> | null }[];
  };
  const byName = new Map<string, { name: string; driver: string; labels: Record<string, string> }>();
  for (const v of listed.Volumes ?? []) {
    byName.set(v.Name, { name: v.Name, driver: v.Driver, labels: v.Labels ?? {} });
  }

  const containers = await d.listContainers({ all: true, filters: { label: [`${STACK_LABEL}=${stack}`] } });
  for (const c of containers) {
    for (const m of c.Mounts ?? []) {
      if (m.Type === 'volume' && m.Name && !byName.has(m.Name)) {
        const info = (await d.getVolume(m.Name).inspect().catch(() => null)) as {
          Name: string;
          Driver: string;
          Labels: Record<string, string> | null;
        } | null;
        if (info) byName.set(info.Name, { name: info.Name, driver: info.Driver, labels: info.Labels ?? {} });
      }
    }
  }

  const volumes = [...byName.values()];
  if (volumes.length === 0) fail(`no named volumes found for stack "${stack}" on this node`);
  return { stack, volumes };
}

/** Running containers that mount any of the given volumes (for --stop quiesce). */
async function containersUsing(docker: DockerClient, volumeNames: string[]): Promise<string[]> {
  const wanted = new Set(volumeNames);
  const containers = await docker.docker.listContainers({ all: false });
  return containers
    .filter((c) => (c.Mounts ?? []).some((m) => m.Type === 'volume' && m.Name && wanted.has(m.Name)))
    .map((c) => c.Id);
}

// ── export ──────────────────────────────────────────────────────────────────

async function backupExport(docker: DockerClient, flags: Set<string>, options: Map<string, string>): Promise<void> {
  const { stack, volumes } = await resolveVolumes(docker, {
    stack: options.get('stack'),
    volumes: options.get('volumes'),
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.resolve(options.get('to') ?? `swarmy-export-${stack ?? 'volumes'}-${stamp}.tar.gz`);
  const quiesce = flags.has('stop');

  say(`exporting ${volumes.length} volume${volumes.length === 1 ? '' : 's'}${stack ? ` from stack ${fmt.bold(stack)}` : ''}:`);
  for (const v of volumes) say(fmt.dim(`  - ${v.name} (${v.driver})`));

  let stopped: string[] = [];
  if (quiesce) {
    const users = await containersUsing(docker, volumes.map((v) => v.name));
    if (users.length > 0) {
      const go = await confirmYesNo(`Stop ${users.length} running container(s) for a consistent copy?`, flags.has('yes'));
      if (!go) fail('aborted (drop --stop for a hot copy)');
      for (const id of users) {
        await docker.docker.getContainer(id).stop({ t: 15 }).catch(() => undefined);
        stopped.push(id);
      }
      say(`${fmt.yellow('⏸')} stopped ${stopped.length} container(s)`);
    }
  } else {
    say(fmt.dim('  hot copy (no --stop): open files may be mid-write; databases should prefer --stop'));
  }

  try {
    const staging = await mkdtemp(path.join(os.tmpdir(), 'swarmy-export-'));
    const manifest: ExportManifest = {
      kind: 'swarmy-rescue-export',
      createdAt: new Date().toISOString(),
      hostname: os.hostname(),
      agentVersion: versionInfo().version,
      stack,
      volumes,
    };
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await mkdir(path.dirname(outFile), { recursive: true });

    // Sidecar: volumes ro under /backup/vols/<name>, manifest under
    // /backup/meta, output dir rw at /out. Result: one tarball, any driver.
    const binds = [
      ...volumes.map((v) => `${v.name}:/backup/vols/${v.name}:ro`),
      `${staging}:/backup/meta:ro`,
      `${path.dirname(outFile)}:/out`,
    ];
    say('packing…');
    const res = await runSidecar(
      docker,
      {
        image: TAR_IMAGE,
        entrypoint: ['/bin/sh', '-c'],
        args: [`tar -czf /out/${path.basename(outFile)} -C /backup meta vols`],
        env: [],
        binds,
      },
      (line) => say(fmt.dim(`  ${line}`)),
    );
    await rm(staging, { recursive: true, force: true });
    if (res.exitCode !== 0) fail(`tar sidecar failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);

    const size = Bun.file(outFile).size;
    say(`${fmt.green('✓')} wrote ${fmt.bold(outFile)} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    say(fmt.dim(`  restore anywhere with: swarmy-agent backup restore --from ${outFile}`));
  } finally {
    for (const id of stopped) {
      await docker.docker.getContainer(id).start().catch(() => undefined);
    }
    if (stopped.length > 0) say(`${fmt.green('▶')} restarted ${stopped.length} container(s)`);
  }
}

// ── restore ─────────────────────────────────────────────────────────────────

async function backupRestore(docker: DockerClient, flags: Set<string>, options: Map<string, string>): Promise<void> {
  const from = options.get('from');
  if (!from) fail('usage: swarmy-agent backup restore --from <export.tar.gz> [--force]');
  const file = path.resolve(from);
  if (!(await Bun.file(file).exists())) fail(`no such file: ${file}`);

  const manifest = await readManifest(file);
  say(`export from ${fmt.bold(manifest.hostname)} at ${manifest.createdAt}${manifest.stack ? ` (stack ${manifest.stack})` : ''}`);
  for (const v of manifest.volumes) say(fmt.dim(`  - ${v.name}`));

  // Refuse to write into existing volumes unless forced — restores must never
  // silently clobber live data.
  const existing: string[] = [];
  for (const v of manifest.volumes) {
    const found = await docker.docker.getVolume(v.name).inspect().catch(() => null);
    if (found) existing.push(v.name);
  }
  if (existing.length > 0 && !flags.has('force')) {
    fail(
      `volume(s) already exist on this node: ${existing.join(', ')}\n` +
        '  Re-run with --force to overwrite their contents (the originals are NOT backed up first).',
    );
  }
  if (existing.length > 0) {
    const go = await confirmYesNo(
      `--force: OVERWRITE the contents of ${existing.length} existing volume(s)?`,
      flags.has('yes'),
    );
    if (!go) fail('aborted');
  }

  for (const v of manifest.volumes) {
    await docker.docker.createVolume({ Name: v.name, Labels: v.labels }).catch(() => undefined);
  }

  say('unpacking…');
  const binds = [
    ...manifest.volumes.map((v) => `${v.name}:/backup/vols/${v.name}`),
    `${path.dirname(file)}:/in:ro`,
  ];
  const res = await runSidecar(
    docker,
    {
      image: TAR_IMAGE,
      entrypoint: ['/bin/sh', '-c'],
      // Overwrite-in-place semantics; only the vols/ subtree is extracted.
      args: [`tar -xzf /in/${path.basename(file)} -C /backup vols`],
      env: [],
      binds,
    },
    (line) => say(fmt.dim(`  ${line}`)),
  );
  if (res.exitCode !== 0) fail(`tar sidecar failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
  say(`${fmt.green('✓')} restored ${manifest.volumes.length} volume(s)`);
  if (manifest.stack) {
    say(fmt.dim(`  Redeploying stack "${manifest.stack}" from the dashboard will pick these volumes up by name.`));
  }
}

async function readManifest(file: string): Promise<ExportManifest> {
  const manifest = await tryReadManifest(file);
  if (!manifest) fail(`not a swarmy export (no valid meta/manifest.json in ${file})`);
  return manifest;
}

/** Non-fatal manifest sniff — null when the file isn't a swarmy export. */
async function tryReadManifest(file: string): Promise<ExportManifest | null> {
  try {
    // Host tar just for the manifest (tiny); data moves via sidecar.
    const proc = Bun.spawn(['tar', '-xzOf', file, 'meta/manifest.json'], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const manifest = JSON.parse(out) as ExportManifest;
    return manifest.kind === 'swarmy-rescue-export' ? manifest : null;
  } catch {
    return null;
  }
}

// ── push (restic, operator-supplied creds) ──────────────────────────────────

async function backupPush(docker: DockerClient, options: Map<string, string>): Promise<void> {
  const { stack, volumes } = await resolveVolumes(docker, {
    stack: options.get('stack'),
    volumes: options.get('volumes'),
  });
  const repo = await collectRepo(options);
  const tags = ['rescue', ...(stack ? [`stack:${stack}`] : []), ...(options.get('tag') ? [options.get('tag')!] : [])];

  say(`pushing ${volumes.length} volume(s) to ${fmt.bold(repo.repo)}…`);
  await ensureRepo(docker, DEFAULT_RESTIC_IMAGE, repo, undefined);

  for (const v of volumes) {
    say(`  ${fmt.cyan('▸')} ${v.name}`);
    const res = await runSidecar(
      docker,
      {
        image: DEFAULT_RESTIC_IMAGE,
        args: ['backup', '/data', '--json', '--host', v.name, ...tags.flatMap((t) => ['--tag', t])],
        env: repoEnv(repo),
        binds: [`${v.name}:/data:ro`],
      },
      () => {},
    );
    if (res.exitCode !== 0) fail(`restic backup of ${v.name} failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    const summary = parseSummary(res.stdout);
    say(
      `    ${fmt.green('✓')} snapshot ${summary.snapshot_id ?? '?'} ` +
        fmt.dim(`(${(((summary.total_bytes_processed ?? 0) as number) / 1024 / 1024).toFixed(1)}MB)`),
    );
  }
  say(`${fmt.green('✓')} all volumes pushed — restore later via the dashboard or \`backup list --repo …\``);
}

/** Repo + credentials: flags for addresses, ENV/PROMPT for secrets — never argv. */
async function collectRepo(options: Map<string, string>): Promise<ResticRepo> {
  const repoUrl = options.get('repo') ?? process.env.RESTIC_REPOSITORY;
  if (!repoUrl) fail('pass --repo <restic-repository> (e.g. s3:s3.amazonaws.com/bucket/prefix) or set RESTIC_REPOSITORY');
  let password = process.env.RESTIC_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) fail('set RESTIC_PASSWORD (no TTY to prompt)');
    process.stdout.write('restic repository password (input hidden is not supported; will echo): ');
    for await (const line of console) {
      password = line.trim();
      break;
    }
  }
  if (!password) fail('empty restic password');
  return {
    kind: repoUrl.startsWith('s3:') ? 's3' : 'node',
    repo: repoUrl,
    password,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_DEFAULT_REGION,
  } satisfies Partial<ResticRepo> as ResticRepo;
}

// ── list ────────────────────────────────────────────────────────────────────

async function backupList(docker: DockerClient, options: Map<string, string>): Promise<void> {
  const repoUrl = options.get('repo') ?? (options.has('from') ? undefined : process.env.RESTIC_REPOSITORY);
  if (repoUrl || options.get('repo')) {
    const repo = await collectRepo(options);
    const res = await runSidecar(
      docker,
      { image: DEFAULT_RESTIC_IMAGE, args: ['snapshots', '--json'], env: repoEnv(repo), binds: [] },
      () => {},
    );
    if (res.exitCode !== 0) fail(`restic snapshots failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`);
    const snapshots = JSON.parse(res.stdout || '[]') as ResticSnapshotInfo[];
    if (snapshots.length === 0) {
      say('no snapshots in the repository');
      return;
    }
    say(fmt.dim(`${'ID'.padEnd(12)} ${'TIME'.padEnd(22)} ${'HOST/VOLUME'.padEnd(24)} TAGS`));
    for (const s of snapshots) {
      say(
        `${s.id.slice(0, 10).padEnd(12)} ${(s.time ?? '').slice(0, 19).padEnd(22)} ` +
          `${(s.hostname ?? '?').padEnd(24)} ${(s.tags ?? []).join(',')}`,
      );
    }
    return;
  }

  // Any .tar.gz might be an export (--to allows arbitrary names) — sniff the
  // manifest and show only the ones that really are.
  const dir = path.resolve(options.get('from') ?? '.');
  const candidates = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.tar.gz'));
  let found = 0;
  for (const f of candidates) {
    const manifest = await tryReadManifest(path.join(dir, f));
    if (!manifest) continue;
    found += 1;
    say(
      `${fmt.bold(f)}\n  ${manifest.createdAt} — ${manifest.hostname}${manifest.stack ? `, stack ${manifest.stack}` : ''}, ${manifest.volumes.length} volume(s)`,
    );
  }
  if (found === 0) say(`no swarmy exports in ${dir} ${fmt.dim('(and no --repo given)')}`);
}
