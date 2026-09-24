/**
 * Controller-store failover e2e (resilience P3), against a real Garage and
 * Litestream on local Docker:
 *
 *   bun run scripts/e2e/controller-store/harness.ts
 *
 * Scenarios (each "controller" is sim-controller.ts in its own data dir,
 * standing in for a node-local swarmy-data volume):
 *   1. crash    write, SIGKILL, start on an EMPTY volume → restored from the
 *               replica; reports the loss window (rows and ms).
 *   2. move     SIGTERM (clean stop: final sync + lease release), start on
 *               another empty volume → zero loss, lease taken at once.
 *   3. stale    start again on the FIRST volume (an old lineage) → boot
 *               detects the stale file, moves it aside and restores.
 *   4. fence    steal the lease (a higher epoch) → the holder exits 70
 *               within the fence window and ships nothing after.
 *
 * Env: LITESTREAM_BIN (else downloaded), GARAGE_IMAGE (default the swarmy pin),
 * KEEP=1 to leave the Garage container running.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, arch, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Subprocess } from 'bun';

const ROOT = mkdtempSync(join(process.env.E2E_DIR ?? tmpdir(), 'swarmy-cs-e2e-'));
const GARAGE_IMAGE = process.env.GARAGE_IMAGE ?? 'dxflrs/garage:v2.4.1';
const LS_VERSION = '0.5.17';
const NAME = `swarmy-cs-e2e-garage-${randomBytes(3).toString('hex')}`;
const log = (m: string) => console.log(`[e2e] ${m}`);
const results: Array<{ scenario: string; ok: boolean; detail: string }> = [];

async function sh(cmd: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0 && !opts.allowFail) throw new Error(`${cmd.join(' ')} → ${code}: ${e || o}`);
  return o.trim();
}

async function litestreamBin(): Promise<string> {
  if (process.env.LITESTREAM_BIN) return process.env.LITESTREAM_BIN;
  const os = platform() === 'darwin' ? 'darwin' : 'linux';
  const a = arch() === 'arm64' ? 'arm64' : 'x86_64';
  const dir = join(tmpdir(), `swarmy-litestream-${LS_VERSION}`);
  const bin = join(dir, 'litestream');
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const url = `https://github.com/benbjohnson/litestream/releases/download/v${LS_VERSION}/litestream-${LS_VERSION}-${os}-${a}.tar.gz`;
    log(`downloading ${url}`);
    await sh(['sh', '-c', `curl -fsSL ${url} | tar -xz -C ${dir}`]);
  }
  log(`litestream: ${await sh([bin, 'version'])}`);
  return bin;
}

async function startGarage(): Promise<{ endpoint: string; accessKeyId: string; secretAccessKey: string }> {
  const cfgDir = join(ROOT, 'garage');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'garage.toml'),
    [
      'metadata_dir = "/var/lib/garage/meta"',
      'data_dir = "/var/lib/garage/data"',
      'db_engine = "sqlite"',
      'replication_factor = 1',
      'rpc_bind_addr = "[::]:3901"',
      'rpc_public_addr = "127.0.0.1:3901"',
      `rpc_secret = "${randomBytes(32).toString('hex')}"`,
      '[s3_api]',
      's3_region = "garage"',
      'api_bind_addr = "[::]:3900"',
      '[admin]',
      'api_bind_addr = "[::]:3903"',
      `admin_token = "${randomBytes(16).toString('hex')}"`,
      '',
    ].join('\n'),
  );
  await sh(['docker', 'run', '-d', '--name', NAME, '-p', '127.0.0.1::3900', '-v', `${cfgDir}/garage.toml:/etc/garage.toml:ro`, GARAGE_IMAGE]);
  const g = (...a: string[]) => sh(['docker', 'exec', NAME, '/garage', ...a]);
  let id = '';
  for (let i = 0; i < 30 && !id; i++) {
    const st = await g('status').catch(() => '');
    id = /^([0-9a-f]{16})\s/m.exec(st)?.[1] ?? '';
    if (!id) await Bun.sleep(500);
  }
  if (!id) throw new Error('garage did not come up');
  await g('layout', 'assign', '-z', 'dc1', '-c', '1G', id);
  await g('layout', 'apply', '--version', '1');
  await g('bucket', 'create', 'swarmy-control');
  await g('key', 'create', 'swarmy-control-litestream');
  await g('bucket', 'allow', '--read', '--write', 'swarmy-control', '--key', 'swarmy-control-litestream');
  const info = await g('key', 'info', 'swarmy-control-litestream', '--show-secret');
  const accessKeyId = /Key ID:\s*(\S+)/.exec(info)?.[1];
  const secretAccessKey = /Secret key:\s*(\S+)/i.exec(info)?.[1];
  if (!accessKeyId || !secretAccessKey) throw new Error(`could not parse garage key:\n${info}`);
  const port = (await sh(['docker', 'port', NAME, '3900/tcp'])).split(':').pop();
  log(`garage ${GARAGE_IMAGE} up on 127.0.0.1:${port}, bucket swarmy-control`);
  return { endpoint: `http://127.0.0.1:${port}`, accessKeyId, secretAccessKey };
}

interface Sim {
  name: string;
  proc: Subprocess<'ignore', 'pipe', 'inherit'>;
  lines: string[];
  lastCommitted: number;
  booted: number | null;
  waitFor(re: RegExp, ms: number): Promise<string>;
}

function startSim(name: string, dataDir: string, node: string, env: Record<string, string>): Sim {
  const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, 'sim-controller.ts')], {
    env: {
      ...process.env,
      ...env,
      SWARMY_DATA_DIR: dataDir,
      SWARMY_TASK_ID: `task-${name}`,
      SWARMY_NODE_ID: node,
      SWARMY_NODE_HOSTNAME: node,
      SWARMY_LITESTREAM_CONFIG: join(dataDir, 'litestream.yml'),
      SWARMY_LITESTREAM_SOCKET: `/tmp/swarmy-e2e-${randomBytes(3).toString('hex')}.sock`,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const sim: Sim = {
    name,
    proc,
    lines: [],
    lastCommitted: 0,
    booted: null,
    async waitFor(re, ms) {
      const until = Date.now() + ms;
      let seen = 0;
      while (Date.now() < until) {
        for (; seen < sim.lines.length; seen++) if (re.test(sim.lines[seen]!)) return sim.lines[seen]!;
        await Bun.sleep(50);
      }
      throw new Error(`${name}: timed out waiting for ${re} (last: ${sim.lines.slice(-5).join(' | ')})`);
    },
  };
  void (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const c of proc.stdout) {
      buf += dec.decode(c, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        sim.lines.push(line);
        const m = /^COMMITTED (\d+)/.exec(line);
        if (m) sim.lastCommitted = Number(m[1]);
        const b = /^BOOTED (\d+)/.exec(line);
        if (b) sim.booted = Number(b[1]);
        if (!m && !line.startsWith('STATUS')) console.log(`  ${name}| ${line}`);
      }
    }
  })();
  return sim;
}

function record(scenario: string, ok: boolean, detail: string) {
  results.push({ scenario, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${scenario}: ${detail}`);
}

async function main(): Promise<void> {
  const bin = await litestreamBin();
  const s3 = await startGarage();
  const storeFile = join(ROOT, 'control_store.json');
  writeFileSync(
    storeFile,
    JSON.stringify({
      version: 1,
      replica: { kind: 'garage', label: 'Garage (e2e)', endpoint: s3.endpoint, bucket: 'swarmy-control', prefix: 'control', region: 'garage', ...s3 },
    }),
  );
  const env = { SWARMY_CONTROL_STORE_FILE: storeFile, SWARMY_LITESTREAM_BIN: bin, E2E_LEASE_FILE: join(ROOT, 'lease.json'), E2E_WRITE_EVERY_MS: '50' };
  const vol = (n: string) => {
    const d = join(ROOT, `vol-${n}`);
    mkdirSync(d, { recursive: true });
    return d;
  };

  // 1. crash → empty volume
  const volA = vol('a');
  const a = startSim('ctl-a', volA, 'node-a', env);
  await a.waitFor(/^LOG controller store: replicating/, 60_000);
  await Bun.sleep(4_000);
  a.proc.kill('SIGKILL');
  await a.proc.exited;
  const killedAt = a.lastCommitted;
  log(`ctl-a SIGKILLed after committing id ${killedAt}`);
  const b = startSim('ctl-b', vol('b'), 'node-b', env);
  await b.waitFor(/^BOOTED /, 60_000);
  const lostRows = killedAt - (b.booted ?? 0);
  record('crash → restore on an empty volume', (b.booted ?? 0) > 0 && lostRows >= 0 && lostRows * 50 <= 2_000, `restored up to id ${b.booted} of ${killedAt}: lost ${lostRows} rows ≈ ${lostRows * 50} ms of writes`);
  const t0 = Date.now();
  await b.waitFor(/^LEADER /, 60_000);
  log(`ctl-b took the lease ${Math.round((Date.now() - t0) / 1000)}s after boot (the dead holder's TTL)`);
  await b.waitFor(/^LOG controller store: replicating/, 30_000);
  await Bun.sleep(3_000);

  // 2. clean move (SIGTERM) → zero loss, immediate takeover
  b.proc.kill('SIGTERM');
  await b.proc.exited;
  const stoppedAt = b.lastCommitted;
  const c = startSim('ctl-c', vol('c'), 'node-c', env);
  await c.waitFor(/^BOOTED /, 60_000);
  const t1 = Date.now();
  await c.waitFor(/^LEADER /, 20_000);
  record('clean move (SIGTERM) → zero loss', c.booted === stoppedAt, `stopped at id ${stoppedAt}, restored ${c.booted}; lease taken ${Date.now() - t1} ms after boot`);
  await c.waitFor(/^LOG controller store: replicating/, 30_000);
  await Bun.sleep(3_000);
  c.proc.kill('SIGTERM');
  await c.proc.exited;
  const cStopped = c.lastCommitted;

  // 3. back on the first volume (stale lineage)
  const d = startSim('ctl-a2', volA, 'node-a', env);
  await d.waitFor(/^BOOTED /, 60_000);
  const aside = readdirSync(volA).filter((f) => f.includes('.stale-'));
  record('stale local file → moved aside, restored', d.booted === cStopped && aside.length > 0, `restored ${d.booted} (latest ${cStopped}); kept ${aside.join(', ') || 'nothing'}`);
  await d.waitFor(/^LOG controller store: replicating/, 60_000);
  await Bun.sleep(2_000);

  // 4. fence: another controller takes the lease at a higher epoch
  const live = JSON.parse(readFileSync(env.E2E_LEASE_FILE, 'utf8')) as { epoch: number };
  writeFileSync(env.E2E_LEASE_FILE, JSON.stringify({ holder: 'task-intruder', node: 'node-z', epoch: live.epoch + 1, renewedAt: Date.now(), ttlMs: 30_000 }));
  const t2 = Date.now();
  const code = await Promise.race([d.proc.exited, Bun.sleep(30_000).then(() => -1)]);
  const fencedIn = Date.now() - t2;
  const fenced = d.lines.some((l) => l.includes('FENCED'));
  record('lease lost → self-fence', code === 70 && fenced && fencedIn <= 12_000, `exit ${code} after ${fencedIn} ms (renew interval 10 s)`);

  const failed = results.filter((r) => !r.ok);
  console.log('\n── summary ──');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario}\n      ${r.detail}`);
  if (failed.length) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error(`[e2e] error: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP !== '1') await sh(['docker', 'rm', '-f', NAME], { allowFail: true });
  log(`artifacts in ${ROOT}`);
}
