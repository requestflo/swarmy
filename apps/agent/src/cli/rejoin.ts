/**
 * `swarmy-agent rejoin [--force]` — swarm-membership repair ladder.
 *
 * The controller normally orchestrates swarm membership on registration, so
 * the green path here is just "make sure the agent is registered". The force
 * paths exist for the two situations that genuinely need local surgery:
 *
 *   - stale/mismatched membership (e.g. advertising a LAN IP while the mesh
 *     is up, or membership in a dead swarm): worker → leave --force and let
 *     the controller re-join it correctly; the swarm-left watchdog restarts
 *     the daemon, whose mesh-first join now REUSES the connected mesh client,
 *     so the fresh registration carries the mesh IP.
 *   - sole manager needing to move (addr migration / lost quorum):
 *     `docker swarm init --force-new-cluster --advertise-addr <meshIp>` —
 *     re-forms the cluster in place, KEEPING services and data.
 *
 * Both force paths are red-tier: typed confirmation, never `--yes`.
 */
import { DockerClient } from '@swarmy/core/docker';
import { env } from '../env';
import { sampleMeshState } from '../handlers/mesh';
import { confirmPhrase, daemonReconnect, daemonStatus, fail, fmt, say, timebox } from './context';
import {
  explainReformFailure,
  hostOf,
  shouldRestartDockerFirst,
  stalePeers,
  type ReformAttempt,
  type RemoteManager,
} from './rejoin-plan';

export async function rejoinCommand(flags: Set<string>): Promise<void> {
  const force = flags.has('force');
  const docker = new DockerClient(env.DOCKER_SOCKET);
  const swarm = await docker.swarmState().catch(() => 'inactive' as const);
  const mesh = await sampleMeshState().catch(() => null);
  const meshIp = mesh?.connected ? mesh.meshIp : undefined;

  if (swarm === 'locked') {
    fail('the swarm is autolocked — run `docker swarm unlock` with your unlock key first');
  }

  if (swarm === 'inactive') {
    // Not in a swarm: registration triggers controller-side orchestration.
    const daemon = await daemonStatus();
    if (daemon?.connected) {
      say('not in a swarm — asking the controller to orchestrate the join (forcing a re-register)…');
      await daemonReconnect();
      say(`${fmt.green('✓')} re-register requested. The controller drives the swarm join; watch: swarmy-agent logs -f`);
    } else {
      say('not in a swarm and not connected to the controller — fixing the connection first');
      const { reconnectCommand } = await import('./reconnect');
      await reconnectCommand();
    }
    return;
  }

  if (swarm === 'pending' || swarm === 'error') {
    say(fmt.yellow(`swarm state is "${swarm}" — the join is stuck (manager unreachable from here?).`));
    if (!force) {
      say('Diagnose with `swarmy-agent doctor` (mesh + controller checks), or restart the join with:');
      say(fmt.bold('  swarmy-agent rejoin --force'));
      return;
    }
    return forceWorkerRejoin(docker, meshIp);
  }

  // swarm === 'active'
  const raw = (await (docker.docker.info() as Promise<unknown>).catch(() => null)) as {
    Swarm?: { NodeAddr?: string; ControlAvailable?: boolean };
  } | null;
  const nodeAddr = raw?.Swarm?.NodeAddr;
  const isManager = raw?.Swarm?.ControlAvailable ?? false;

  if (!meshIp || nodeAddr === meshIp) {
    say(`${fmt.green('✓')} swarm membership looks correct (${isManager ? 'manager' : 'worker'}, advertising ${nodeAddr ?? '?'})`);
    if (!force) return;
    say(fmt.yellow('(--force requested anyway)'));
  } else {
    say(fmt.yellow(`advertising ${nodeAddr}, but the mesh IP is ${meshIp} — swarm traffic is off-mesh.`));
    if (!force) {
      say('Fix by re-forming this node\'s membership on the mesh IP:');
      say(fmt.bold('  swarmy-agent rejoin --force'));
      return;
    }
  }

  if (!isManager) return forceWorkerRejoin(docker, meshIp);
  return forceManagerReform(docker, meshIp);
}

/** Worker force path: leave, let the controller re-join us on the right address. */
async function forceWorkerRejoin(_docker: DockerClient, meshIp: string | undefined): Promise<void> {
  const go = await confirmPhrase(
    'This will LEAVE the swarm: every task running on this node stops until the controller re-joins it ' +
      `(usually well under a minute).${meshIp ? ` It will rejoin advertising the mesh IP ${meshIp}.` : ''}`,
    'rejoin swarm',
  );
  if (!go) {
    say('aborted');
    return;
  }
  await run(['docker', 'swarm', 'leave', '--force']);
  say(`${fmt.green('✓')} left the swarm`);
  say(
    'The agent\'s swarm watchdog restarts the daemon now; the fresh registration lets the controller ' +
      're-orchestrate the join. Watch: swarmy-agent logs -f',
  );
}

/**
 * Manager force path. On a multi-manager swarm, leaving is the same as the
 * worker path (the swarm survives on the remaining managers). On a SOLE
 * manager, leaving would destroy the cluster — `--force-new-cluster` re-forms
 * it in place instead, keeping services/configs/secrets, on the new address.
 *
 * Every Docker call here is time-boxed: `--force-new-cluster` against raft
 * state that still lists a dead peer used to stall until `context deadline
 * exceeded` and leave the node half-broken. We probe RemoteManagers for stale
 * peers first, restart dockerd when the control plane is wedged / stale peers
 * exist (what the operator had to do by hand), bound the reform, and retry
 * once after a docker restart on a deadline.
 */
async function forceManagerReform(docker: DockerClient, meshIp: string | undefined): Promise<void> {
  const nodes = await timebox(LIST_NODES_TIMEOUT_MS, () => docker.listNodes());
  const controlPlaneResponsive = nodes !== null;
  const managers = nodes ? nodes.filter((n) => n.role === 'manager').length : 1;

  if (managers > 1) {
    const go = await confirmPhrase(
      `This manager will LEAVE the swarm (the cluster survives on the other ${managers - 1} manager(s)); ` +
        'tasks on this node stop until the controller re-joins it.',
      'rejoin swarm',
    );
    if (!go) {
      say('aborted');
      return;
    }
    await run(['docker', 'swarm', 'leave', '--force']);
    say(`${fmt.green('✓')} left the swarm — the controller will re-join this node. Watch: swarmy-agent logs -f`);
    return;
  }

  const stale = await detectStalePeers(docker);
  if (!controlPlaneResponsive) say(fmt.yellow('the swarm control plane is not answering (docker node ls timed out).'));
  if (stale.length) say(fmt.yellow(`stale swarm peer address(es) in local raft state: ${stale.join(', ')}`));
  const restartFirst = shouldRestartDockerFirst({ controlPlaneResponsive, stale });

  // Sole manager.
  const go = await confirmPhrase(
    'This is the ONLY manager. The swarm will be re-formed in place with `docker swarm init --force-new-cluster`' +
      `${meshIp ? ` on the mesh IP ${meshIp}` : ''}. Services, configs and secrets are KEPT, but every other node ` +
      'must re-join (the controller re-joins online workers automatically).' +
      (restartFirst ? ' The Docker daemon is restarted first to clear the wedged/stale swarm state.' : ''),
    'force new cluster',
  );
  if (!go) {
    say('aborted');
    return;
  }

  let restarted = false;
  if (restartFirst) restarted = await restartDocker();

  const args = ['docker', 'swarm', 'init', '--force-new-cluster', ...(meshIp ? ['--advertise-addr', meshIp] : [])];
  for (;;) {
    say(`running: ${args.join(' ')} (time-boxed ${REFORM_TIMEOUT_MS / 1000}s)`);
    const attempt = await runBounded(args, REFORM_TIMEOUT_MS);
    if (!attempt.timedOut && attempt.exitCode === 0) break;
    const verdict = explainReformFailure(attempt, stale, restarted);
    say(fmt.red(verdict.message));
    if (verdict.retryAfterDockerRestart && (await restartDocker())) {
      restarted = true;
      say('retrying once after the docker restart…');
      continue;
    }
    fail(
      'cluster NOT re-formed. Check `journalctl -u docker`, then rerun `swarmy-agent rejoin --force`. ' +
        'If the manager is unrecoverable, the controller re-elects a new manager automatically once ' +
        'this node is off the swarm (`docker swarm leave --force`).',
    );
  }
  say(`${fmt.green('✓')} cluster re-formed${meshIp ? ` on ${meshIp}` : ''}`);

  const leftover = await detectStalePeers(docker);
  if (leftover.length) {
    say(
      fmt.yellow(
        `warning: raft state still advertises unreachable manager address(es) ${leftover.join(', ')} — ` +
          'overlay network creation can fail ("no VNI provided") until the swarm is rebuilt.',
      ),
    );
  }
  // Let the controller see the reformed manager straight away; workers pull
  // fresh join tokens from it (never the stale stored ones) when they re-join.
  if (await timebox(5_000, () => daemonReconnect())) {
    say('re-register requested so the controller picks up the reformed swarm');
  } else {
    say('Trigger a re-register so the controller sees the reformed swarm: swarmy-agent reconnect');
  }
}

const LIST_NODES_TIMEOUT_MS = 10_000;
const REFORM_TIMEOUT_MS = 60_000;
const LEAVE_TIMEOUT_MS = 60_000;
const DOCKER_RESTART_TIMEOUT_MS = 90_000;
const PEER_PROBE_TIMEOUT_MS = 2_000;

/** RemoteManagers entries that aren't us and don't answer on their swarm port. */
async function detectStalePeers(docker: DockerClient): Promise<string[]> {
  const info = (await timebox(5_000, () => docker.docker.info() as Promise<unknown>)) as {
    Swarm?: { NodeID?: string; NodeAddr?: string; RemoteManagers?: RemoteManager[] | null };
  } | null;
  const remote = info?.Swarm?.RemoteManagers ?? [];
  const probed = new Map<string, boolean>();
  await Promise.all(
    remote
      .filter((r) => r.Addr)
      .map(async (r) => probed.set(r.Addr!, await tcpReachable(r.Addr!, PEER_PROBE_TIMEOUT_MS))),
  );
  return stalePeers(remote, { nodeId: info?.Swarm?.NodeID, nodeAddr: info?.Swarm?.NodeAddr }, (a) => probed.get(a) ?? true);
}

async function tcpReachable(addr: string, ms: number): Promise<boolean> {
  const host = hostOf(addr);
  const port = Number(addr.slice(addr.lastIndexOf(':') + 1)) || 2377;
  const ok = await timebox(ms, async () => {
    const sock = await Bun.connect({ hostname: host, port, socket: { data() {}, error() {} } });
    sock.end();
    return true;
  });
  return ok === true;
}

/** Restart dockerd (systemd hosts). Returns true when docker answers again. */
async function restartDocker(): Promise<boolean> {
  if (!Bun.which('systemctl')) {
    say(fmt.yellow('cannot restart docker automatically (no systemctl) — restart the Docker daemon, then retry.'));
    return false;
  }
  say('restarting the Docker daemon (clears wedged swarm/raft state)…');
  const r = await runBounded(['systemctl', 'restart', 'docker'], DOCKER_RESTART_TIMEOUT_MS);
  if (r.timedOut || r.exitCode !== 0) {
    say(fmt.red(`systemctl restart docker ${r.timedOut ? 'timed out' : 'failed'}: ${r.stderr.trim()}`));
    return false;
  }
  const docker = new DockerClient(env.DOCKER_SOCKET);
  for (let i = 0; i < 30; i++) {
    if (await timebox(2_000, () => docker.docker.ping())) return true;
    await Bun.sleep(1_000);
  }
  say(fmt.red('docker did not come back within 60s of the restart'));
  return false;
}

/** Spawn with a hard deadline; kills the process on timeout. Never hangs. */
async function runBounded(cmd: string[], timeoutMs: number): Promise<ReformAttempt> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, timeoutMs);
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text().catch(() => '')]);
  clearTimeout(timer);
  if (stderr) process.stderr.write(stderr);
  return { timedOut, exitCode: timedOut ? null : exitCode, stderr };
}

async function run(cmd: string[], timeoutMs = LEAVE_TIMEOUT_MS): Promise<void> {
  const r = await runBounded(cmd, timeoutMs);
  if (r.timedOut) fail(`${cmd.join(' ')} timed out after ${timeoutMs / 1000}s — try \`systemctl restart docker\`, then retry`);
  if (r.exitCode !== 0) fail(`${cmd.join(' ')} failed`);
}
