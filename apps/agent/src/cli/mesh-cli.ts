/**
 * `swarmy-agent mesh <status|join|leave|ping>` — local mesh operations.
 *
 *   mesh status            live client state + peer table
 *   mesh ping <ip>         ICMP a mesh peer (rides the wt0 interface)
 *   mesh join              (re)join using SWARMY_MESH_* env or --setup-key
 *   mesh leave             remove the mesh client container (yellow tier)
 */
import { DockerClient } from '@swarmy/core/docker';
import type { RenderedMesh } from '@swarmy/core/protocol';
import { env } from '../env';
import { applyMesh, sampleMeshState } from '../handlers/mesh';
import { confirmYesNo, fail, fmt, GLYPH, say } from './context';

export async function meshCommand(argv: string[], flags: Set<string>, options: Map<string, string>): Promise<void> {
  const sub = argv[0] ?? 'status';
  switch (sub) {
    case 'status':
      return meshStatus(flags.has('json'));
    case 'ping':
      return meshPing(argv[1]);
    case 'join':
      return meshJoin(options.get('setup-key'), options.get('management-url'));
    case 'leave':
      return meshLeave(flags.has('yes'));
    default:
      fail(`unknown mesh subcommand "${sub}" — try: status | ping <ip> | join | leave`);
  }
}

async function meshStatus(json: boolean): Promise<void> {
  const state = await sampleMeshState();
  if (json) {
    say(JSON.stringify(state, null, 2));
    return;
  }
  if (!state) {
    say(fmt.dim('no mesh client on this node'));
    return;
  }
  say('');
  say(
    `  ${state.connected ? GLYPH.ok : GLYPH.fail} ${state.driver} ${state.connected ? 'connected' : 'NOT connected'}` +
      `${state.meshIp ? ` as ${fmt.bold(state.meshIp)}` : ''}${state.error ? ` — ${fmt.red(state.error)}` : ''}`,
  );
  const peers = state.peers ?? [];
  if (peers.length > 0) {
    say('');
    say(fmt.dim(`  ${'PEER'.padEnd(18)} ${'STATE'.padEnd(12)} PATH`));
    for (const p of peers) {
      const ip = (p.meshIp ?? p.peerId ?? '?').padEnd(18);
      const st = p.connected ? fmt.green('connected'.padEnd(12)) : fmt.red('down'.padEnd(12));
      const path = p.connected ? (p.relayed ? fmt.yellow('relayed') : 'direct') : '';
      say(`  ${ip} ${st} ${path}`);
    }
  }
  say('');
}

async function meshPing(target: string | undefined): Promise<void> {
  if (!target) fail('usage: swarmy-agent mesh ping <mesh-ip>');
  const proc = Bun.spawn(['ping', '-c', '4', target], { stdout: 'inherit', stderr: 'inherit' });
  process.exit(await proc.exited);
}

async function meshJoin(setupKeyFlag: string | undefined, managementUrlFlag: string | undefined): Promise<void> {
  const setupKey = setupKeyFlag ?? env.MESH_SETUP_KEY;
  const managementUrl = managementUrlFlag ?? env.MESH_MANAGEMENT_URL;
  if (!setupKey) {
    fail(
      'no setup key: pass --setup-key <key> or set SWARMY_MESH_SETUP_KEY.\n' +
        '  Setup keys are single-use — mint a fresh one from the dashboard (Add a node / repair).',
    );
  }
  const docker = new DockerClient(env.DOCKER_SOCKET);
  const rendered: RenderedMesh = {
    driver: (env.MESH_DRIVER || 'netbird') as RenderedMesh['driver'],
    action: 'join',
    client: {
      kind: 'netbird',
      setupKey,
      managementUrl: managementUrl || undefined,
      interface: 'wt0',
      advertiseRoutes: [],
      acceptRoutes: true,
    },
    files: [],
    summary: 'cli mesh join',
  };
  say('joining mesh…');
  await applyMesh(docker, rendered);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await sampleMeshState().catch(() => null);
    if (state?.connected) {
      say(`${fmt.green('✓')} mesh connected${state.meshIp ? ` as ${state.meshIp}` : ''}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  fail('mesh client started but did not confirm connectivity within 20s — check `swarmy-agent mesh status`');
}

async function meshLeave(autoYes: boolean): Promise<void> {
  const go = await confirmYesNo(
    'Leave the mesh? Swarm traffic riding mesh IPs will lose its path until this node rejoins.',
    autoYes,
  );
  if (!go) {
    say('aborted');
    return;
  }
  const docker = new DockerClient(env.DOCKER_SOCKET);
  const rendered: RenderedMesh = {
    driver: (env.MESH_DRIVER || 'netbird') as RenderedMesh['driver'],
    action: 'leave',
    files: [],
    summary: 'cli mesh leave',
  };
  await applyMesh(docker, rendered);
  say(`${fmt.green('✓')} mesh client removed`);
}
