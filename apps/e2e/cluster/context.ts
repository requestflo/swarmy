/**
 * Shared state every scenario step gets: the cluster, an authenticated
 * dashboard session, and a REST/SDK client on an API key the harness minted.
 */
import type { SwarmyClient } from '../../../sdks/typescript/src/index';
import { rest, restClient, Session } from './lib/api';
import type { Cluster, ClusterNode } from './lib/cluster';
import { log, poll, secret } from './lib/util';

export interface Options {
  keep: boolean;
  only: string[] | null;
  skip: string[];
  enable: string[];
  reuse: boolean;
  reportDir: string;
  reduced: boolean;
}

export class Ctx {
  session!: Session;
  sdk!: SwarmyClient;
  apiKey = '';
  apiKeyId = '';
  password = '';
  readonly runId = Date.now().toString(36);
  /** Values steps hand forward (e.g. a stack name another step reuses). */
  readonly kv = new Map<string, string>();

  constructor(
    readonly cluster: Cluster,
    readonly opts: Options,
  ) {}

  get url() {
    return this.cluster.controllerUrl;
  }

  /** Sign in as the first admin and mint a REST API key (idempotent). */
  async connect(password?: string) {
    await this.cluster.refreshIps();
    await poll('controller /health', () => this.cluster.controllerHealthy(), { timeoutMs: 180_000, intervalMs: 3000 });
    this.password = secret(password ?? (await this.cluster.adminPasswordFromNode()));
    this.session = new Session(this.url, this.cluster.controllerOrigin);
    await poll('admin sign-in', async () => (await this.session.signIn(this.cluster.cfg.adminEmail, this.password), true), {
      timeoutMs: 120_000,
      intervalMs: 4000,
    });
    if (!this.apiKey) {
      const created = await this.session.mutate<{ id: string; key: string }>('apiKeys.create', {
        name: `e2e-cluster-${this.runId}`,
        scopes: ['read', 'write'],
      });
      this.apiKey = secret(created.key);
      this.apiKeyId = created.id;
      log(`minted API key ${created.id} (read+write)`);
    }
    this.sdk = restClient(this.url, this.apiKey);
  }

  rest<T = any>(method: string, path: string, body?: unknown) {
    return rest<T>(this.url, this.apiKey, method, path, body);
  }

  q<T = any>(proc: string, input?: unknown, timeoutMs?: number) {
    return this.session.query<T>(proc, input, timeoutMs);
  }
  m<T = any>(proc: string, input?: unknown, timeoutMs?: number) {
    return this.session.mutate<T>(proc, input, timeoutMs);
  }

  /** docker CLI on the manager node. */
  docker(args: string, timeoutMs?: number) {
    return this.cluster.docker(args, timeoutMs);
  }

  node(i: number): ClusterNode {
    return this.cluster.nodes[i - 1]!;
  }

  private hostnames = new Map<string, ClusterNode>();
  /** The swarm hostname of a cluster node (what `docker service ps` prints). */
  async hostnameOf(n: ClusterNode): Promise<string> {
    for (const [h, x] of this.hostnames) if (x === n) return h;
    const h = (await this.cluster.mustSh(n, 'hostname')).trim();
    this.hostnames.set(h, n);
    return h;
  }
  async nodeByHostname(h: string): Promise<ClusterNode> {
    if (!this.hostnames.has(h)) for (const n of this.cluster.nodes) await this.hostnameOf(n);
    const n = this.hostnames.get(h);
    if (!n) throw new Error(`no cluster node with hostname ${h}`);
    return n;
  }

  /** Where a service's running task lives: the node and its container id. */
  async task(service: string): Promise<{ node: ClusterNode; cid: string }> {
    const out = await this.docker(
      `service ps ${service} --filter desired-state=running --format '{{.Node}} {{.CurrentState}}'`,
    );
    const line = out.split('\n').find((l) => / Running/.test(l));
    if (!line) throw new Error(`${service}: no running task (${out.trim().split('\n')[0] ?? 'none'})`);
    const node = await this.nodeByHostname(line.split(' ')[0]!);
    const cid = (
      await this.cluster.mustSh(node, `docker ps -q --filter label=com.docker.swarm.service.name=${service} | head -n1`)
    ).trim();
    if (!cid) throw new Error(`${service}: task on ${node.name} has no container yet`);
    return { node, cid };
  }

  /** `docker exec` into a service's running task, wherever it is scheduled. */
  async execIn(service: string, cmd: string, opts: { env?: Record<string, string>; timeoutMs?: number } = {}) {
    const { node, cid } = await this.task(service);
    // Env values (passwords) go over stdin into a root-only file, never argv.
    const envArgs = Object.keys(opts.env ?? {}).map((k) => `-e ${k}`).join(' ');
    const input = Object.entries(opts.env ?? {}).map(([k, v]) => `export ${k}=${shq(v)}`).join('\n') + '\n';
    const script = `set -a; . /dev/stdin; set +a; docker exec ${envArgs} ${cid} sh -c ${shq(cmd)}`;
    return this.cluster.mustSh(node, script, { input, timeoutMs: opts.timeoutMs ?? 120_000 }, `${service}: ${cmd.slice(0, 50)}`);
  }
}

function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
