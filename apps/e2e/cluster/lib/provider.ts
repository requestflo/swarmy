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
  /**
   * Launch a node. `daemonJson` is the /etc/docker/daemon.json the node's
   * dockerd must have from its FIRST start (a provider whose Docker is already
   * running, like dind, seeds it here; Lima installs Docker later).
   */
  create(name: string, spec: NodeSpec, daemonJson: string): Promise<void>;
  /** The node's address the HOST reaches it on (API calls, edge checks). */
  ip(name: string): Promise<string>;
  /** The node's address the OTHER NODES reach it on (swarm advertise, agent dial). */
  fabricIp(name: string): Promise<string>;
  /** host:port the HOST uses to reach `port` on the node (a published port on Docker Desktop). */
  hostEndpoint(name: string, port: number): Promise<string>;
  /** Run once on a fresh node, before anything is installed. */
  prepare(name: string): Promise<void>;
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
  async create(name: string, spec: NodeSpec, _daemonJson: string) {
    await must(
      [
        'limactl', 'start', '--tty=false', '--timeout=10m', `--name=${name}`,
        `--cpus=${spec.cpus}`, `--memory=${spec.memGiB}`, `--disk=${spec.diskGiB}`,
        // vzNAT: routable from the Mac, but macOS isolates vzNAT guests from
        // EACH OTHER (ARP between VMs fails). lima:user-v2 is Lima's virtual L2
        // switch — VM↔VM for TCP/UDP/ESP — so it carries the swarm.
        '--network=vzNAT', '--network=lima:user-v2', '--containerd=none', `template:ubuntu-${this.release}`,
      ],
      { timeoutMs: 12 * 60_000 },
      `limactl start ${name}`,
    );
  }
  private async addr(name: string, dev: string) {
    const r = await this.sh(name, `ip -4 -o addr show dev ${dev} | awk '{print $4}' | cut -d/ -f1 | head -n1`);
    const ip = r.stdout.trim();
    if (!ip) throw new Error(`${name}: no ${dev} address`);
    return ip;
  }
  ip(name: string) {
    return this.addr(name, 'lima0');
  }
  fabricIp(name: string) {
    return this.addr(name, 'eth0');
  }
  async hostEndpoint(name: string, port: number) {
    return `${await this.ip(name)}:${port}`;
  }
  async prepare(name: string) {
    // Make the user-v2 fabric the default route, so the installer's "local
    // IP" (ip route get 1.1.1.1) — the swarm advertise address — is the one
    // the other VMs can reach. Also drop the Mac's DHCP search domain: Docker
    // copies it into every container, and a droplet has none (busybox
    // nslookup of a bare service name then fails). Persisted via netplan.
    const r = await this.sh(
      name,
      // netplan apply briefly drops the routes; wait for DHCP to put them back.
      `sed -i -e '0,/route-metric: 200/s//route-metric: 50/' -e '/route-metric:/a\\        use-domains: false' /etc/netplan/50-cloud-init.yaml && netplan apply 2>/dev/null; for i in $(seq 1 30); do ip -4 route get 1.1.1.1 2>/dev/null | grep -q 'dev eth0' && break; sleep 1; done; ip -4 route get 1.1.1.1 | grep -o 'dev [a-z0-9]*'`,
      { timeoutMs: 60_000 },
    );
    if (!r.stdout.includes('dev eth0')) throw new Error(`${name}: default route is not the user-v2 fabric (${r.stdout.trim()} ${r.stderr.trim()})`);
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

export { DindProvider } from './provider-dind';
