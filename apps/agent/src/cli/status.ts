/**
 * `swarmy-agent status [--json]` — one-glance node summary. Fast path of
 * doctor: daemon socket + a couple of direct probes, no fix logic.
 */
import { DockerClient } from '@swarmy/core/docker';
import { env } from '../env';
import { loadState } from '../state';
import { sampleMeshState } from '../handlers/mesh';
import { versionInfo } from '../version';
import { daemonStatus, fmt, GLYPH, humanDuration, say, timebox } from './context';

export async function statusCommand(flags: Set<string>): Promise<void> {
  const docker = new DockerClient(env.DOCKER_SOCKET);
  const [daemon, mesh, swarm, state] = await Promise.all([
    daemonStatus(),
    timebox(3_000, () => sampleMeshState()),
    timebox(3_000, () => docker.swarmState()),
    loadState(),
  ]);
  const v = versionInfo();

  if (flags.has('json')) {
    say(
      JSON.stringify(
        {
          version: v.version,
          commit: v.commit,
          daemon,
          savedSession: state ? { nodeId: state.nodeId, sessionVersion: state.sessionVersion } : null,
          mesh: mesh ?? null,
          swarmState: swarm ?? 'unknown',
        },
        null,
        2,
      ),
    );
    return;
  }

  say('');
  say(`${fmt.bold('swarmy-agent')} v${v.version} ${fmt.dim(`(commit ${v.commit})`)}`);
  say('');

  if (daemon) {
    const link = daemon.connected
      ? fmt.green(`connected to ${daemon.wsUrl}`)
      : daemon.lastAuthReject
        ? fmt.red(`auth rejected: ${daemon.lastAuthReject.code} ${daemon.lastAuthReject.reason}`)
        : fmt.yellow(`not connected to ${daemon.wsUrl}`);
    row('daemon', `${GLYPH.ok} running (pid ${daemon.pid}, up ${humanDuration(daemon.uptimeSec)}) — ${link}`);
    row(
      'node',
      daemon.nodeId
        ? `${daemon.nodeId} ${fmt.dim(`(session v${daemon.sessionVersion}${daemon.sessionPersisted ? ', persisted' : fmt.yellow(', NOT persisted')})`)}`
        : fmt.dim('not registered yet'),
    );
  } else {
    row('daemon', `${GLYPH.fail} not running ${fmt.dim(`(no socket at ${env.SOCKET_PATH})`)}`);
    row(
      'node',
      state
        ? `${state.nodeId} ${fmt.dim(`(saved session v${state.sessionVersion})`)}`
        : fmt.dim(`no saved session at ${env.STATE_PATH}`),
    );
  }

  if (mesh) {
    row(
      'mesh',
      mesh.connected
        ? `${GLYPH.ok} ${mesh.driver} connected as ${mesh.meshIp ?? '?'} ${fmt.dim(`(${(mesh.peers ?? []).filter((p) => p.connected).length}/${(mesh.peers ?? []).length} peers)`)}`
        : `${GLYPH.fail} ${mesh.driver} present but not connected`,
    );
  } else {
    row('mesh', fmt.dim('no mesh client on this node'));
  }

  row(
    'swarm',
    swarm === 'active' ? `${GLYPH.ok} active` : swarm ? `${GLYPH.warn} ${swarm}` : fmt.dim('docker unavailable'),
  );
  say('');
  say(fmt.dim('  Full diagnostics: swarmy-agent doctor'));
  say('');
}

function row(label: string, value: string): void {
  say(`  ${label.padEnd(8)} ${value}`);
}
