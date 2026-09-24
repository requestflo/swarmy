#!/usr/bin/env bun
/**
 * swarmy cluster e2e — build a FRESH multi-node swarmy on local VMs (or
 * docker-in-docker in CI) and prove the product end to end through the REST
 * API + TypeScript SDK (and the dashboard's tRPC where REST has no route yet).
 *
 *   bash scripts/e2e-cluster.sh                     # full run, fresh VMs, teardown
 *   bash scripts/e2e-cluster.sh --keep              # leave the cluster up afterwards
 *   bash scripts/e2e-cluster.sh --only postgres     # one step against a kept cluster
 *   bash scripts/e2e-cluster.sh --provider dind --reduced   # the CI shape
 *
 * Flags:
 *   --provider lima|dind   node provider (default: lima on macOS, dind elsewhere)
 *   --keep                 leave nodes up (teardown step is skipped)
 *   --only a,b             run only these steps against the existing cluster
 *   --skip a,b             skip these steps
 *   --enable a,b           force flagged steps on (controller-move, upgrade)
 *   --reuse                don't delete an existing cluster before install
 *   --source head|tree|REF build from `git archive HEAD` (default), the working tree, or a git ref
 *   --no-build             reuse images already built (skip docker build)
 *   --mesh none|self-hosted   TODO: self-hosted once the mesh epic lands
 *   --upgrade-from REF     with --enable upgrade: install REF first (default: the parent of --source)
 *   --nodes N  --cpus N  --mem GiB  --disk GiB   (default 3 × 1 CPU / 1 GiB / 25 GiB, a 1 GB droplet)
 *   --reduced              CI mode: skip the steps a runner can't do (see REDUCED)
 *   --report-dir DIR       report.json, junit.xml, summary.txt, diagnostics/
 *
 * Steps: install login servers templates compose-secret dns postgres
 *        mariadb-redis reschedule controller-move upgrade teardown
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cluster, type ClusterConfig } from './lib/cluster';
import { DindProvider, LimaProvider, type Provider } from './lib/provider';
import { Report, Skip } from './lib/report';
import { color, say } from './lib/util';
import { Ctx, type Options } from './context';
import * as platform from './steps/platform';
import * as apps from './steps/apps';
import * as data from './steps/data';

interface StepDef {
  id: string;
  title: string;
  fn: (ctx: Ctx) => Promise<string | void>;
  /** A failure here makes every later step meaningless. */
  gate?: boolean;
}

const STEPS: StepDef[] = [
  { id: 'install', title: 'fresh VMs + install-swarmy.sh one-liner on node 1', fn: platform.install, gate: true },
  { id: 'login', title: 'first-admin login + API key (REST/SDK)', fn: platform.login, gate: true },
  { id: 'servers', title: 'add servers (agent one-liner → swarm workers)', fn: platform.servers },
  { id: 'templates', title: 'deploy templates (umami, uptime-kuma) + URLs answer', fn: apps.templates },
  { id: 'compose-secret', title: 'compose app with a secret variable', fn: apps.composeSecret },
  { id: 'dns', title: 'container-to-container DNS across nodes', fn: apps.crossNodeDns },
  { id: 'postgres', title: 'managed Postgres: rows → backup → restore as copy', fn: data.postgres },
  { id: 'mariadb-redis', title: 'MariaDB + Redis logical dump and restore', fn: data.mariadbRedis },
  { id: 'reschedule', title: 'kill a worker → tasks reschedule, node rejoins', fn: platform.reschedule },
  { id: 'controller-move', title: 'controller move/restore (P3, flagged)', fn: platform.controllerMove },
  { id: 'upgrade', title: 'platform upgrade previous → current (flagged)', fn: platform.upgrade },
  { id: 'teardown', title: 'teardown', fn: platform.teardown },
];

/** What a GitHub runner (dind, no nested virt) cannot meaningfully do. */
const REDUCED: Record<string, string> = {
  // Killing a dind container is a fair "node died", but the dind nodes share
  // one kernel, so it doesn't exercise a real host reboot + agent restart.
  // Kept on: it still proves rescheduling.
};

function parseArgs(argv: string[]) {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    const [name, inline] = k.slice(2).split('=', 2) as [string, string | undefined];
    if (['keep', 'reuse', 'reduced', 'no-build', 'help'].includes(name)) a[name] = true;
    else a[name] = inline ?? argv[++i] ?? '';
  }
  return a;
}
const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    const src = await Bun.file(import.meta.path).text();
    console.log(src.split('*/')[0]!.replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  const providerKind = (a.provider as string) || (process.platform === 'darwin' ? 'lima' : 'dind');
  const provider: Provider = providerKind === 'lima' ? new LimaProvider() : new DindProvider(Number(a['registry-port'] ?? 5055));
  const mesh = ((a.mesh as string) || 'none') as ClusterConfig['mesh'];
  if (mesh !== 'none') {
    // TODO(mesh): flip once the self-hosted NetBird control plane ships
    // (plans/epic-self-hosted-mesh-and-fleets.md) and install-swarmy.sh takes
    // `--mesh self-hosted`; servers() then NATs node 3 and joins it over wt0.
    throw new Error(`--mesh ${mesh}: the self-hosted mesh isn't available yet; use --mesh none`);
  }
  const only = list(a.only);
  for (const id of [...only, ...list(a.skip), ...list(a.enable)]) {
    if (!STEPS.some((s) => s.id === id)) throw new Error(`unknown step "${id}" (valid: ${STEPS.map((s) => s.id).join(' ')})`);
  }
  const workDir = join(process.env.SWARMY_E2E_WORKDIR || join(tmpdir(), 'swarmy-e2e-cluster'));
  const reportDir = (a['report-dir'] as string) || join(workDir, 'report');
  mkdirSync(workDir, { recursive: true });

  const opts: Options = {
    keep: !!a.keep,
    only: only.length ? only : null,
    skip: list(a.skip),
    enable: list(a.enable),
    reuse: !!a.reuse || only.length > 0,
    reportDir,
    reduced: !!a.reduced,
  };
  const cfg: ClusterConfig = {
    prefix: (a.prefix as string) || 'swarmy-e2e',
    nodeCount: Number(a.nodes ?? 3),
    spec: { cpus: Number(a.cpus ?? 1), memGiB: Number(a.mem ?? 1), diskGiB: Number(a.disk ?? 25) },
    source: (a.source as string) || 'head',
    workDir,
    registryPort: Number(a['registry-port'] ?? 5055),
    filePort: Number(a['file-port'] ?? 18088),
    mesh,
    adminEmail: 'e2e@example.com',
    tag: 'e2e',
    noBuild: !!a['no-build'],
    // "Previous build" defaults to the parent of what's being tested.
    upgradeFrom:
      (a['upgrade-from'] as string) ||
      (!a.source || a.source === 'head' ? 'HEAD~1' : a.source === 'tree' ? 'HEAD' : `${a.source as string}~1`),
  };

  const cluster = new Cluster(cfg, provider);
  const ctx = new Ctx(cluster, opts);
  const report = new Report({
    provider: provider.kind,
    nodes: String(cfg.nodeCount),
    size: `${cfg.spec.cpus}cpu/${cfg.spec.memGiB}GiB`,
    mesh,
    source: cfg.source === 'tree' ? 'working-tree' : cfg.source === 'head' ? 'HEAD' : cfg.source,
  });

  say(`swarmy cluster e2e · provider=${provider.kind} nodes=${cfg.nodeCount} mesh=${mesh} report=${reportDir}`);

  let selected = STEPS.filter((s) => (opts.only ? opts.only.includes(s.id) : true));
  // --only against a kept cluster: attach (sign in, mint a key) unless the
  // selection itself starts from install/login.
  if (opts.only && !opts.only.includes('install') && !opts.only.includes('login')) {
    await cluster.prepareSource();
    cluster.startFileServer();
    await ctx.connect();
  }
  let gated = '';
  for (const s of selected) {
    if (opts.skip.includes(s.id)) {
      await report.step(s.id, s.title, async () => { throw new Skip('--skip'); });
      continue;
    }
    if (opts.reduced && REDUCED[s.id]) {
      await report.step(s.id, s.title, async () => { throw new Skip(`reduced (CI): ${REDUCED[s.id]}`); });
      continue;
    }
    if (gated && s.id !== 'teardown') {
      await report.step(s.id, s.title, async () => { throw new Skip(`prerequisite "${gated}" failed`); });
      continue;
    }
    const r = await report.step(s.id, s.title, () => s.fn(ctx));
    if (r.status === 'fail') {
      await cluster.diagnostics(join(reportDir, 'diagnostics', s.id)).catch(() => {});
      if (s.gate) gated = s.id;
    }
  }
  cluster.stopFileServer();
  report.write(reportDir);
  console.log(report.summary());
  console.log(color.dim(`reports: ${join(reportDir, 'report.json')} · ${join(reportDir, 'junit.xml')}`));
  process.exit(report.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(color.red(`✗ ${(e as Error).message}`));
  process.exit(2);
});
