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
import { confirmPhrase, daemonReconnect, daemonStatus, fail, fmt, say } from './context';

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
 */
async function forceManagerReform(docker: DockerClient, meshIp: string | undefined): Promise<void> {
  const managers = await docker
    .listNodes()
    .then((nodes) => nodes.filter((n) => n.role === 'manager').length)
    .catch(() => 1);

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

  // Sole manager.
  const go = await confirmPhrase(
    'This is the ONLY manager. The swarm will be re-formed in place with `docker swarm init --force-new-cluster`' +
      `${meshIp ? ` on the mesh IP ${meshIp}` : ''}. Services, configs and secrets are KEPT, but every other node ` +
      'must re-join (the controller re-joins online workers automatically).',
    'force new cluster',
  );
  if (!go) {
    say('aborted');
    return;
  }
  await run(['docker', 'swarm', 'init', '--force-new-cluster', ...(meshIp ? ['--advertise-addr', meshIp] : [])]);
  say(`${fmt.green('✓')} cluster re-formed${meshIp ? ` on ${meshIp}` : ''}`);
  say('Trigger a re-register so the controller stores the new join tokens: swarmy-agent reconnect');
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) fail(`${cmd.join(' ')} failed`);
}
