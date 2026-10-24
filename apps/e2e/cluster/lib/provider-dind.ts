/**
 * docker-in-docker node provider — the CI shape (GitHub runners have no nested
 * virt): privileged docker:dind containers on one bridge network. No systemd,
 * so workers run the container agent backend; see the notes in run.ts.
 */
import type { NodeSpec, Provider, ShOpts } from './provider';
import { must, q, run } from './util';

/**
 * The node's boot command. dockerd reads /etc/docker/daemon.json at EVERY
 * start and refuses to start at all when a flag repeats one of its keys
 * ("the following directives are specified both as a flag and in the
 * configuration file: insecure-registries"). The nodes used to get
 * `--insecure-registry` as a flag while the harness (and the installers) wrote
 * daemon.json, so the FIRST restart — the reschedule step's kill + start —
 * left the node's dockerd dead and the node never came back. So: no flags;
 * the harness's daemon.json is seeded on first boot and never overwritten
 * (the installers merge their log rotation + registry mirror into it).
 */
export function dindBoot(dir = '/etc/docker'): string {
  const f = `${dir}/daemon.json`;
  return `mkdir -p ${dir} && { [ -s ${f} ] || printf '%s\\n' "$SWARMY_E2E_DAEMON_JSON" > ${f}; } && exec dockerd-entrypoint.sh`;
}

/** Pure: `docker run` argv for a node. Nothing after the boot script: no dockerd flags. */
export function dindRunArgs(o: { name: string; spec: NodeSpec; daemonJson: string; network: string; image: string; publish: boolean }): string[] {
  return [
    'docker', 'run', '-d', '--privileged', '--name', o.name, '--hostname', o.name, '--label', 'swarmy.test=e2e-cluster',
    '--network', o.network, `--memory=${o.spec.memGiB}g`, `--cpus=${o.spec.cpus}`,
    // Docker Desktop: publish the controller + edge ports (random host ports).
    ...(o.publish ? ['-p', '127.0.0.1::3021', '-p', '127.0.0.1::443'] : []),
    '-e', 'DOCKER_TLS_CERTDIR=', '-e', `SWARMY_E2E_DAEMON_JSON=${o.daemonJson}`,
    '--entrypoint', 'sh', o.image, '-c', dindBoot(),
  ];
}

export class DindProvider implements Provider {
  readonly kind = 'dind' as const;
  readonly agentBackend = 'docker' as const;
  readonly serveHost = '0.0.0.0';
  constructor(
    private readonly registryPort: number,
    /** The bridge the nodes share (named after --prefix, so two clusters can coexist). */
    readonly network = 'swarmy-e2e',
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
  private async ensureNetwork() {
    if ((await run(['docker', 'network', 'inspect', this.network])).code === 0) return;
    // Nodes are created in parallel: losing the create race is fine.
    const r = await run(['docker', 'network', 'create', '--label', 'swarmy.test=e2e-cluster', this.network]);
    if (r.code !== 0 && !/already exists/.test(r.stderr)) throw new Error(`docker network create: ${r.stderr.trim()}`);
  }

  async create(name: string, spec: NodeSpec, daemonJson: string) {
    await this.ensureNetwork();
    await must(dindRunArgs({ name, spec, daemonJson, network: this.network, image: this.image, publish: process.platform === 'darwin' }));
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
  fabricIp(name: string) {
    return this.ip(name);
  }
  async hostEndpoint(name: string, port: number) {
    // Docker Desktop can't route to container IPs: use the published port.
    if (process.platform !== 'darwin') return `${await this.ip(name)}:${port}`;
    const r = await must(['docker', 'port', name, `${port}/tcp`]);
    return r.split('\n')[0]!.trim().replace(/^0\.0\.0\.0/, '127.0.0.1');
  }
  async prepare(_name: string) {}
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
    // Docker Desktop (macOS): the bridge gateway lives inside Desktop's VM.
    if (process.platform === 'darwin') return 'host.docker.internal';
    await this.ensureNetwork(); // asked before the first node exists (daemon.json)
    const r = await must(['docker', 'network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}}{{end}}', this.network]);
    return r.trim();
  }
}
