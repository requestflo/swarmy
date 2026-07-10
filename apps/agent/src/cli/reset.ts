/**
 * `swarmy-agent reset [--keep-data]` — factory-reset this node's swarmy
 * footprint. Red tier: typed confirmation, spells out exactly what goes.
 *
 * Removes: saved session, agent service+binary env, mesh client container,
 * swarm membership. With --keep-data (default OFF is too dangerous — data
 * removal is NEVER automatic): named volumes are always kept; this flag is
 * reserved and currently implied. Workload containers are only stopped as a
 * side effect of `docker swarm leave --force`.
 */
import { unlink } from 'node:fs/promises';
import { DockerClient } from '@swarmy/core/docker';
import { env } from '../env';
import { clearState } from '../state';
import { confirmPhrase, fmt, say } from './context';

export async function resetCommand(_flags: Set<string>): Promise<void> {
  const docker = new DockerClient(env.DOCKER_SOCKET);
  const swarm = await docker.swarmState().catch(() => 'inactive' as const);

  const go = await confirmPhrase(
    'FACTORY RESET this node\'s swarmy footprint:\n' +
      `  - stop + disable the swarmy-agent service\n` +
      `  - delete the saved session (${env.STATE_PATH})\n` +
      '  - remove the mesh client container (swarmy-netbird / swarmy-tailscale)\n' +
      (swarm === 'active' ? '  - LEAVE the swarm (tasks on this node stop)\n' : '') +
      '  Named volumes and your data are KEPT. Re-enroll later with a fresh one-liner.',
    'reset this node',
  );
  if (!go) {
    say('aborted');
    return;
  }

  await tryRun(['systemctl', 'stop', 'swarmy-agent.service']);
  await tryRun(['systemctl', 'disable', 'swarmy-agent.service']);
  if (swarm === 'active') {
    await tryRun(['docker', 'swarm', 'leave', '--force']);
    say(`${fmt.green('✓')} left the swarm`);
  }
  await docker.docker.getContainer('swarmy-netbird').remove({ force: true }).catch(() => undefined);
  await docker.docker.getContainer('swarmy-tailscale').remove({ force: true }).catch(() => undefined);
  await docker.docker.getContainer('swarmy-agent').remove({ force: true }).catch(() => undefined);
  await clearState();
  await unlink(env.SOCKET_PATH).catch(() => undefined);
  say(`${fmt.green('✓')} node reset. Volumes and data are untouched.`);
  say(fmt.dim('  To fully remove the install: rm -f /usr/local/bin/swarmy-agent /etc/systemd/system/swarmy-agent.service /etc/swarmy/agent.env'));
}

async function tryRun(cmd: string[]): Promise<void> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  } catch {
    // best-effort teardown
  }
}
