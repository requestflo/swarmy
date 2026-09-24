/**
 * Node providers — where the cluster's "servers" come from.
 *
 *   lima  real Ubuntu VMs on macOS (vz + vzNAT: every VM gets a routable
 *         192.168.64.x address the host and the other VMs reach directly).
 *         The launch-rehearsal target: systemd, real kernel, real reboots.
 *   dind  privileged docker:dind containers on one bridge network — the CI
 *         shape (GitHub runners have no nested virt). No systemd, so workers
 *         run the container agent backend; see README notes in run.ts.
 */
import { must, q, run, type ExecResult } from './util';

export interface NodeSpec {
  cpus: number;
  memGiB: number;
  diskGiB: number;
}

export interface ShOpts {
  input?: string | Uint8Array;
  timeoutMs?: number;
  stream?: boolean;
}

export interface Provider {
  readonly kind: 'lima' | 'dind';
  /** Agent install backend for workers on this provider. */
  readonly agentBackend: 'systemd' | 'docker';
  exists(name: string): Promise<boolean>;
  running(name: string): Promise<boolean>;
  create(name: string, spec: NodeSpec): Promise<void>;
  /** The node's address the host and the other nodes reach it on. */
  ip(name: string): Promise<string>;
  /** Run a bash script as root on the node. */
  sh(name: string, script: string, opts?: ShOpts): Promise<ExecResult>;
  /** Hard power-off (simulates a node dying — no graceful shutdown). */
  kill(name: string): Promise<void>;
  start(name: string): Promise<void>;
  destroy(name: string): Promise<void>;
  /** Copy a locally-built image into the node's Docker engine. */
  loadImage(name: string, image: string): Promise<void>;
  /** Host address a node uses to reach a server the harness runs on the host. */
  hostAddr(name: string): Promise<string>;
  /** Interface the harness's file server must bind to be reachable from nodes. */
  readonly serveHost: string;
  /** List nodes this harness created (by name prefix). */
  list(prefix: string): Promise<string[]>;
}

// ── Lima ──────────────────────────────────────────────────────────────────
export class LimaProvider implements Provider {
  readonly kind = 'lima' as const;
  readonly agentBackend = 'systemd' as const;
  // host.lima.internal (the slirp gateway) forwards to the Mac's loopback, so
  // the file server never needs a LAN-facing socket or a firewall prompt.
  readonly serveHost = '127.0.0.1';

  constructor(private readonly release = '24.04') {}

  async exists(name: string) {
    const r = await run(['limactl', 'list', '--format', '{{.Name}}']);
    return r.stdout.split('\n').includes(name);
  }
  async running(name: string) {
    const r = await run(['limactl', 'list', name, '--format', '{{.Status}}']);
    return r.stdout.trim() === 'Running';
  }
  async list(prefix: string) {
    const r = await run(['limactl', 'list', '--format', '{{.Name}}']);
    return r.stdout.split('\n').filter((n) => n.startsWith(prefix));
  }
  async create(name: string, spec: NodeSpec) {
    await must(
      [
        'limactl', 'start', '--tty=false', '--timeout=10m', `--name=${name}`,
        `--cpus=${spec.cpus}`, `--memory=${spec.memGiB}`, `--disk=${spec.diskGiB}`,
        '--network=vzNAT', '--containerd=none', `template:ubuntu-${this.release}`,
      ],
      { timeoutMs: 12 * 60_000 },
      `limactl start ${name}`,
    );
  }
  async ip(name: string) {
    const r = await this.sh(name, `ip -4 -o addr show dev lima0 | awk '{print $4}' | cut -d/ -f1 | head -n1`);
    const ip = r.stdout.trim();
    if (!ip) throw new Error(`${name}: no lima0 (vzNAT) address`);
    return ip;
  }
  sh(name: string, script: string, opts: ShOpts = {}) {
    return run(['limactl', 'shell', '--workdir', '/', name, '--', 'sudo', 'bash', '-c', script], opts);
  }
  async kill(name: string) {
    await must(['limactl', 'stop', '--force', name], { timeoutMs: 120_000 }, `limactl stop ${name}`);
  }
  async start(name: string) {
    await must(['limactl', 'start', '--tty=false', name], { timeoutMs: 10 * 60_000 }, `limactl start ${name}`);
  }
  async destroy(name: string) {
    if (await this.exists(name)) await must(['limactl', 'delete', '--force', name], { timeoutMs: 180_000 });
  }
  async loadImage(name: string, image: string) {
    // docker save | gzip → ssh → docker load. gzip -1 keeps CPU cost low; the
    // pipe beats a registry here (no insecure-registry daemon config needed).
    await must(
      ['bash', '-c', `set -o pipefail; docker save ${q(image)} | gzip -1 | limactl shell --workdir / ${q(name)} -- sudo sh -c 'gunzip | docker load'`],
      { timeoutMs: 15 * 60_000 },
      `load ${image} into ${name}`,
    );
  }
  async hostAddr(_name: string) {
    return 'host.lima.internal';
  }
}

// ── docker-in-docker ──────────────────────────────────────────────────────
export class DindProvider implements Provider {
  readonly kind = 'dind' as const;
  readonly agentBackend = 'docker' as const;
  readonly serveHost = '0.0.0.0';
  constructor(
    private readonly registryPort: number,
    private readonly network = 'swarmy-e2e',
    private readonly image = 'docker:29-dind',
  ) {}

  async exists(name: string) {
    return (await run(['docker', 'inspect', name])).code === 0;
  }
  async running(name: string) {
    const r = await run(['docker', 'inspect', '-f', '{{.State.Running}}', name]);
    return r.stdout.trim() === 'true';
  }
  async list(prefix: string) {
    const r = await run(['docker', 'ps', '-a', '--format', '{{.Names}}']);
    return r.stdout.split('\n').filter((n) => n.startsWith(prefix));
  }
  async create(name: string, spec: NodeSpec) {
    if ((await run(['docker', 'network', 'inspect', this.network])).code !== 0) {
      await must(['docker', 'network', 'create', this.network]);
    }
    await must([
      'docker', 'run', '-d', '--privileged', '--name', name, '--hostname', name,
      '--network', this.network, `--memory=${spec.memGiB}g`, `--cpus=${spec.cpus}`,
      '-e', 'DOCKER_TLS_CERTDIR=', this.image,
      // The harness registry is plain http on the network gateway.
      `--insecure-registry=${await this.hostAddr(name)}:${this.registryPort}`,
    ]);
    // The installer and the agent one-liner need bash/curl/openssl/jq/iproute2.
    await must(
      ['docker', 'exec', name, 'sh', '-c', 'apk add --no-cache bash curl openssl jq iproute2 python3 >/dev/null && for i in $(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'],
      { timeoutMs: 180_000 },
      `prepare ${name}`,
    );
  }
  async ip(name: string) {
    const r = await must(['docker', 'inspect', '-f', `{{(index .NetworkSettings.Networks "${this.network}").IPAddress}}`, name]);
    return r.trim();
  }
  sh(name: string, script: string, opts: ShOpts = {}) {
    return run(['docker', 'exec', ...(opts.input !== undefined ? ['-i'] : []), name, 'bash', '-c', script], opts);
  }
  async kill(name: string) {
    await must(['docker', 'kill', name]);
  }
  async start(name: string) {
    await must(['docker', 'start', name]);
  }
  async destroy(name: string) {
    await run(['docker', 'rm', '-f', '-v', name]);
  }
  async loadImage(name: string, image: string) {
    await must(
      ['bash', '-c', `set -o pipefail; docker save ${q(image)} | docker exec -i ${q(name)} docker load`],
      { timeoutMs: 15 * 60_000 },
      `load ${image} into ${name}`,
    );
  }
  async hostAddr(_name: string) {
    const r = await must(['docker', 'network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}}{{end}}', this.network]);
    return r.trim();
  }
}
