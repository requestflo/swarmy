/**
 * Cluster bring-up: source snapshot → images → local registry → nodes →
 * the real `curl … install-swarmy.sh | bash` one-liner on node 1.
 *
 * Nothing here talks to the product API beyond /health; the scenario steps do.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Provider, NodeSpec } from './provider';
import { log, must, poll, q, run, secret } from './util';

export const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export type Mesh = 'none' | 'self-hosted';

export interface ClusterConfig {
  prefix: string;
  nodeCount: number;
  spec: NodeSpec;
  /** `head` = `git archive HEAD`; `tree` = the working tree as-is; anything else = that git ref. */
  source: string;
  workDir: string;
  registryPort: number;
  filePort: number;
  mesh: Mesh;
  adminEmail: string;
  tag: string;
  /** Skip image builds and reuse the tags already in the local engine. */
  noBuild: boolean;
  /** Git ref the upgrade scenario installs first ("the previous build"). */
  upgradeFrom: string;
}

export interface ClusterNode {
  name: string;
  index: number; // 1-based
  role: 'manager' | 'worker';
  /** node3: joins through the mesh behind a simulated NAT (when a mesh exists). */
  natted: boolean;
  /** Host-facing address (API, edge). */
  ip: string;
  /** Node-to-node address (swarm advertise, agent → controller). */
  fabricIp: string;
}

export class Cluster {
  nodes: ClusterNode[] = [];
  controllerUrl = '';
  controllerOrigin = '';
  commit = '';
  srcDir = '';
  /** What the file server hands out (the installer + stack files of the build being installed). */
  serveRoot = '';
  /** Image tag node 1 was installed with (differs from cfg.tag before an upgrade). */
  installedTag = '';
  private fileServer: ReturnType<typeof Bun.serve> | null = null;

  constructor(
    readonly cfg: ClusterConfig,
    readonly provider: Provider,
  ) {
    this.installedTag = cfg.tag;
    for (let i = 1; i <= cfg.nodeCount; i++) {
      this.nodes.push({
        name: `${cfg.prefix}-${i}`,
        index: i,
        role: i === 1 ? 'manager' : 'worker',
        natted: i === 3,
        ip: '',
        fabricIp: '',
      });
    }
  }

  get manager() {
    return this.nodes[0]!;
  }
  get workers() {
    return this.nodes.slice(1);
  }

  /** Registry host:port as the NODES see it. */
  async registryHost(node = this.manager) {
    return `${await this.provider.hostAddr(node.name)}:${this.cfg.registryPort}`;
  }
  async image(kind: 'controller' | 'agent', tag = this.cfg.tag) {
    return `${await this.registryHost()}/swarmy-${kind}:${tag}`;
  }

  // ── source + images ──────────────────────────────────────────────────────
  async prepareSource() {
    if (this.cfg.source === 'tree') {
      this.commit = (await must(['git', '-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'])).trim() + '-dirty';
      this.srcDir = REPO_ROOT;
    } else {
      const snap = await this.snapshot(this.cfg.source === 'head' ? 'HEAD' : this.cfg.source, 'src');
      this.srcDir = snap.dir;
      this.commit = snap.commit;
    }
    this.serveRoot = this.srcDir;
  }

  /** `git archive <ref>` into workDir/<dirName> — a clean, committed build context. */
  async snapshot(ref: string, dirName: string): Promise<{ dir: string; commit: string }> {
    const commit = (await must(['git', '-C', REPO_ROOT, 'rev-parse', '--short', ref], {}, `git rev-parse ${ref}`)).trim();
    const dir = join(this.cfg.workDir, dirName);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await must(['bash', '-c', `git -C ${q(REPO_ROOT)} archive ${q(commit)} | tar -x -C ${q(dir)}`], {}, `git archive ${ref}`);
    log(`source: git archive ${ref} (${commit}) → ${dir}`);
    return { dir, commit };
  }

  /** Local registry the nodes pull from (insecure, host-local). */
  async ensureRegistry() {
    const name = `${this.cfg.prefix}-registry`;
    const running = await run(['docker', 'inspect', '-f', '{{.State.Running}}', name]);
    if (running.stdout.trim() === 'true') return;
    await run(['docker', 'rm', '-f', name]);
    const bind = this.provider.serveHost === '127.0.0.1' ? '127.0.0.1:' : '';
    await must(['docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', '-p', `${bind}${this.cfg.registryPort}:5000`, 'registry:2']);
    await poll('local registry', async () => (await run(['curl', '-fsS', `http://127.0.0.1:${this.cfg.registryPort}/v2/`])).code === 0, { timeoutMs: 30_000, intervalMs: 1000 });
  }

  /** Build controller + agent images from the snapshot and push to the local registry. */
  /** → the pushed manifest digests (sha256:…) per image. */
  async buildImages(tag = this.cfg.tag, srcDir = this.srcDir, commit = this.commit): Promise<{ controller: string; agent: string }> {
    const digests = { controller: '', agent: '' };
    const local = `127.0.0.1:${this.cfg.registryPort}`;
    for (const [kind, file] of [
      ['controller', 'apps/api/Dockerfile'],
      ['agent', 'apps/agent/Dockerfile'],
    ] as const) {
      const ref = `${local}/swarmy-${kind}:${tag}`;
      if (!this.cfg.noBuild) {
        log(`docker build ${kind} (${file}) …`);
        const t0 = Date.now();
        await must(
          ['docker', 'build', '-q', '-f', file, '--build-arg', `SWARMY_COMMIT=${commit}`, '-t', ref, '.'],
          { cwd: srcDir, timeoutMs: 30 * 60_000 },
          `docker build ${kind}`,
        );
        log(`built ${kind} in ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      await must(['docker', 'push', '-q', ref], { timeoutMs: 15 * 60_000 }, `docker push ${ref}`);
      const rd = await must(['docker', 'image', 'inspect', '-f', '{{range .RepoDigests}}{{println .}}{{end}}', ref]);
      digests[kind] = rd.split('\n').find((l) => l.startsWith(`${local}/swarmy-${kind}@`))?.split('@')[1] ?? '';
    }
    return digests;
  }

  // ── file server (the one-liner's script + stack files) ───────────────────
  startFileServer() {
    if (this.fileServer) return;
    const self = this;
    this.fileServer = Bun.serve({
      hostname: this.provider.serveHost,
      port: this.cfg.filePort,
      fetch(req) {
        const p = new URL(req.url).pathname;
        // Only what a curl|bash install fetches: the installer + stack files.
        if (!/^\/(scripts\/install-swarmy\.sh|deploy\/[\w.-]+\.ya?ml)$/.test(p)) return new Response('not found', { status: 404 });
        const f = join(self.serveRoot, p);
        return existsSync(f) ? new Response(Bun.file(f)) : new Response('not found', { status: 404 });
      },
    });
  }
  stopFileServer() {
    this.fileServer?.stop(true);
    this.fileServer = null;
  }
  async rawBase(node = this.manager) {
    return `http://${await this.provider.hostAddr(node.name)}:${this.cfg.filePort}`;
  }

  // ── nodes ────────────────────────────────────────────────────────────────
  async destroyAll() {
    for (const n of await this.provider.list(`${this.cfg.prefix}-`)) {
      if (n === `${this.cfg.prefix}-registry`) continue;
      log(`deleting ${n}`);
      await this.provider.destroy(n);
    }
  }

  async createNodes() {
    await Promise.all(
      this.nodes.map(async (n) => {
        if (await this.provider.exists(n.name)) throw new Error(`${n.name} already exists — run without --reuse to recreate, or teardown first`);
        log(`launching ${n.name} (${this.cfg.spec.cpus} CPU / ${this.cfg.spec.memGiB} GiB / ${this.cfg.spec.diskGiB} GiB)`);
        await this.provider.create(n.name, this.cfg.spec);
        await this.provider.prepare(n.name);
      }),
    );
    await this.refreshIps();
    // Trust the harness's registry BEFORE Docker is installed, so a fresh box
    // pulls the locally-built images exactly like it would pull ghcr.io.
    const reg = await this.registryHost();
    await Promise.all(
      this.nodes.map((n) =>
        this.sh(n, `mkdir -p /etc/docker && [ -s /etc/docker/daemon.json ] || printf '{"insecure-registries": ["%s"]}\\n' ${q(reg)} > /etc/docker/daemon.json`),
      ),
    );
  }

  async refreshIps() {
    for (const n of this.nodes) {
      if (await this.provider.running(n.name).catch(() => false)) {
        n.ip = await this.provider.ip(n.name);
        n.fabricIp = await this.provider.fabricIp(n.name);
      }
    }
    this.controllerUrl = `http://${await this.provider.hostEndpoint(this.manager.name, 3021)}`;
    // What the installer baked as the public/auth origin (LOGIN_URL = the
    // manager's default-route IP) and what workers dial.
    this.controllerOrigin = `http://${this.manager.fabricIp}:3021`;
  }

  async sh(node: ClusterNode, script: string, opts: { input?: string; timeoutMs?: number; stream?: boolean } = {}) {
    return this.provider.sh(node.name, script, opts);
  }
  async mustSh(node: ClusterNode, script: string, opts: { input?: string; timeoutMs?: number; stream?: boolean } = {}, what?: string) {
    const r = await this.sh(node, script, opts);
    if (r.code !== 0) {
      const tail = (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-15).join('\n');
      throw new Error(`${what ?? `${node.name}: ${script.slice(0, 60)}`} failed (exit ${r.code}): ${tail}`);
    }
    return r.stdout;
  }

  /** docker CLI on the manager. */
  docker(args: string, timeoutMs = 120_000) {
    return this.mustSh(this.manager, `docker ${args}`, { timeoutMs }, `docker ${args.slice(0, 50)}`);
  }

  // ── install (node 1) ─────────────────────────────────────────────────────
  /**
   * The real one-liner, exactly as the README hands it out, with the raw base
   * pointed at the harness's file server instead of GitHub:
   *   curl -fsSL <raw>/scripts/install-swarmy.sh | sudo bash -s -- <flags>
   * The admin password travels in a root-only env file, never on a command line.
   */
  async install(adminPassword: string, extraFlags: string[] = [], tag = this.cfg.tag) {
    const raw = await this.rawBase();
    const flags = [
      '--non-interactive',
      '--admin-email', this.cfg.adminEmail,
      '--image', await this.image('controller', tag),
      '--agent-image', await this.image('agent', tag),
      '--mesh', this.cfg.mesh === 'self-hosted' ? 'self-hosted' : 'none',
      ...extraFlags,
    ];
    await this.mustSh(this.manager, 'umask 077; cat > /root/.swarmy-e2e.env', {
      input: `SWARMY_ADMIN_PASSWORD=${q(adminPassword)}\nSWARMY_RAW_BASE=${q(raw)}\n`,
    });
    const script = `set -a; . /root/.swarmy-e2e.env; set +a; curl -fsSL ${q(`${raw}/scripts/install-swarmy.sh`)} | bash -s -- ${flags.map(q).join(' ')}`;
    const r = await this.sh(this.manager, script, { timeoutMs: 20 * 60_000, stream: true });
    if (r.code !== 0) {
      // Surface WHY (a crash-looping controller's last error) in the step detail.
      const why = await this.sh(
        this.manager,
        `docker service logs --raw --tail 60 swarmy_controller 2>&1 | grep -iE 'error|fatal|cannot' | tail -n1`,
        { timeoutMs: 30_000 },
      ).catch(() => null);
      throw new Error(`install-swarmy.sh exited ${r.code}${why?.stdout.trim() ? `; controller: ${why.stdout.trim().slice(0, 300)}` : ''}`);
    }
  }

  async adminPasswordFromNode(): Promise<string> {
    const out = await this.mustSh(this.manager, `. /var/lib/swarmy/install/state.env && printf '%s' "$ADMIN_PASSWORD"`);
    return secret(out);
  }

  async controllerHealthy() {
    const r = await run(['curl', '-fsS', '-m', '4', `${this.controllerUrl}/health`]);
    return r.code === 0;
  }

  /** Every node's journal/logs worth keeping when a step fails. */
  async diagnostics(dir: string) {
    mkdirSync(dir, { recursive: true });
    const m = this.manager;
    const cmds: Record<string, string> = {
      'services.txt': 'docker service ls; echo; docker node ls',
      'service-ps.txt': 'docker service ps --no-trunc $(docker service ls -q) 2>&1 | head -300',
      'controller.log': 'docker service logs --no-trunc --tail 600 swarmy_controller 2>&1',
      'agent-node1.log': 'docker logs --tail 300 swarmy-agent 2>&1',
    };
    for (const [file, cmd] of Object.entries(cmds)) {
      const r = await this.sh(m, cmd, { timeoutMs: 60_000 }).catch(() => null);
      if (r) await Bun.write(join(dir, file), r.stdout + r.stderr);
    }
    for (const w of this.workers) {
      const r = await this.sh(w, 'journalctl -u swarmy-agent --no-pager -n 300 2>/dev/null || docker logs --tail 300 swarmy-agent 2>&1', { timeoutMs: 60_000 }).catch(() => null);
      if (r) await Bun.write(join(dir, `agent-node${w.index}.log`), r.stdout + r.stderr);
    }
  }
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
