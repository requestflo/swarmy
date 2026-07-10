/**
 * The doctor ladder — ordered, dependency-aware health checks that mirror how
 * a node actually comes up: binary → daemon → docker → controller → session →
 * mesh → swarm → workloads → disk. Each check is time-boxed (nothing hangs),
 * never throws, and may attach a FIX with an explicit danger tier:
 *
 *   green  — safe to run automatically (`doctor --fix`)
 *   yellow — prompted, or `--yes`
 *   red    — typed-phrase confirmation only, NEVER `--yes` (handled by the
 *            commands that own those flows, e.g. `rejoin --force`)
 */
import { DockerClient } from '@swarmy/core/docker';
import { env } from '../env';
import { loadState } from '../state';
import { sampleMeshState } from '../handlers/mesh';
import { versionInfo } from '../version';
import type { DaemonStatus } from '../local-socket';
import { controllerHttpBase, daemonReconnect, daemonStatus, probeController, timebox, type ControllerProbe } from './context';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckFix {
  /** Imperative description shown to the operator ("restart the agent service"). */
  title: string;
  danger: 'green' | 'yellow';
  apply: () => Promise<string>;
}

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** One-line human detail ("connected as node cmr… via ws://…"). */
  detail: string;
  /** Optional multi-line hint rendered dimmed under the row. */
  hint?: string;
  fix?: CheckFix;
}

export interface DoctorReport {
  version: string;
  commit: string;
  generatedAt: string;
  hostname: string;
  checks: CheckResult[];
}

interface Ctx {
  docker: DockerClient;
  daemon: DaemonStatus | null;
  controller: ControllerProbe;
}

const CHECK_TIMEBOX_MS = 6_000;

export async function runChecks(): Promise<DoctorReport> {
  const docker = new DockerClient(env.DOCKER_SOCKET);
  // Shared probes used by several checks — fetch once.
  const [daemon, controller] = await Promise.all([daemonStatus(), probeController()]);
  const ctx: Ctx = { docker, daemon, controller };

  const checks: CheckResult[] = [];
  for (const check of [
    checkBinary,
    checkDaemon,
    checkDocker,
    checkController,
    checkSession,
    checkMesh,
    checkSwarm,
    checkWorkloads,
    checkDisk,
  ]) {
    const result = await timebox(CHECK_TIMEBOX_MS, () => check(ctx));
    checks.push(
      result ?? {
        id: check.name,
        title: check.name.replace(/^check/, ''),
        status: 'fail',
        detail: `check timed out after ${CHECK_TIMEBOX_MS / 1000}s`,
      },
    );
  }

  const v = versionInfo();
  return {
    version: v.version,
    commit: v.commit,
    generatedAt: new Date().toISOString(),
    hostname: (await timebox(1_000, async () => (await import('node:os')).hostname())) ?? 'unknown',
    checks,
  };
}

// ── individual checks ───────────────────────────────────────────────────────

async function checkBinary(ctx: Ctx): Promise<CheckResult> {
  const v = versionInfo();
  const base = { id: 'binary', title: 'Agent binary' };
  if (ctx.controller.reachable && ctx.controller.agentVersion && ctx.controller.agentVersion !== v.version) {
    return {
      ...base,
      status: 'warn',
      detail: `v${v.version} (commit ${v.commit}) — controller serves v${ctx.controller.agentVersion}`,
      hint: 'Re-run the install one-liner (repair mode) or `swarmy-agent update` to pick up the new binary.',
    };
  }
  return { ...base, status: 'ok', detail: `v${v.version} (commit ${v.commit})` };
}

async function checkDaemon(ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'daemon', title: 'Agent daemon' };
  if (ctx.daemon) {
    const d = ctx.daemon;
    return {
      ...base,
      status: 'ok',
      detail: `running (pid ${d.pid}, up ${Math.floor(d.uptimeSec / 60)}m)`,
    };
  }
  // Socket unreachable — is the unit at least configured?
  const unit = await unitState();
  if (unit === 'active') {
    return {
      ...base,
      status: 'warn',
      detail: 'systemd reports active but the diagnostics socket is unreachable',
      hint: `Expected socket at ${env.SOCKET_PATH}. An old (pre-CLI) agent binary has no socket — update the agent.`,
    };
  }
  return {
    ...base,
    status: 'fail',
    detail: unit ? `service is ${unit}` : 'not running (no diagnostics socket, no systemd unit)',
    fix: {
      title: 'restart the swarmy-agent service',
      danger: 'yellow',
      apply: async () => {
        await run(['systemctl', 'restart', 'swarmy-agent.service']);
        return 'systemctl restart swarmy-agent.service issued';
      },
    },
  };
}

async function checkDocker(ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'docker', title: 'Docker engine' };
  const ok = await ctx.docker.ping().catch(() => false);
  if (!ok) {
    return {
      ...base,
      status: 'fail',
      detail: `cannot reach the Docker socket at ${env.DOCKER_SOCKET}`,
      hint: 'Is Docker installed and running? (systemctl status docker) Are you root?',
    };
  }
  const ver = await (ctx.docker.docker.version() as Promise<{ Version?: string }>).catch(() => null);
  return { ...base, status: 'ok', detail: ver?.Version ? `responding (v${ver.Version})` : 'responding' };
}

async function checkController(ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'controller', title: 'Controller (HTTP)' };
  if (!ctx.controller.reachable) {
    return {
      ...base,
      status: 'fail',
      detail: `${controllerHttpBase()} unreachable — ${ctx.controller.error}`,
      hint: 'DNS/firewall/routing to the controller, or the controller is down. Mesh and swarm keep running without it.',
    };
  }
  return { ...base, status: 'ok', detail: `${controllerHttpBase()} reachable (${ctx.controller.latencyMs}ms)` };
}

async function checkSession(ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'session', title: 'Controller session' };
  const d = ctx.daemon;

  if (d?.connected && d.nodeId) {
    const persisted = d.sessionPersisted
      ? ''
      : ' — WARNING: credential not yet persisted to disk (reboot would orphan this node)';
    return {
      ...base,
      status: d.sessionPersisted ? 'ok' : 'warn',
      detail: `registered as ${d.nodeId} (session v${d.sessionVersion})${persisted}`,
    };
  }

  if (d?.lastAuthReject) {
    const r = d.lastAuthReject;
    const hasToken = d.hasJoinToken;
    return {
      ...base,
      status: 'fail',
      detail: `controller rejected auth: ${r.code} ${r.reason}`,
      hint: hasToken
        ? 'The join token in /etc/swarmy/agent.env is no longer valid (consumed/revoked/expired). ' +
          'Re-run the install one-liner from the dashboard (repair mode) to re-authenticate this node.'
        : 'No join token available to re-enroll. Re-run the install one-liner from the dashboard (repair mode).',
    };
  }

  if (d && !d.connected) {
    return {
      ...base,
      status: 'fail',
      detail: 'daemon is running but not connected to the controller',
      hint: ctx.controller.reachable
        ? 'Controller HTTP is reachable — likely a WS-specific problem. Try `swarmy-agent reconnect`.'
        : 'Controller is unreachable (see the check above) — fix reachability first.',
      fix: {
        title: 'force an immediate redial',
        danger: 'green',
        apply: async () => ((await daemonReconnect()) ? 'redial requested' : 'daemon socket did not accept the request'),
      },
    };
  }

  // Daemon down — inspect the state file directly.
  const state = await loadState();
  if (state) {
    return {
      ...base,
      status: 'warn',
      detail: `saved session for node ${state.nodeId} (v${state.sessionVersion}) — daemon not running to use it`,
    };
  }
  return {
    ...base,
    status: 'fail',
    detail: `no saved session at ${env.STATE_PATH}`,
    hint: env.JOIN_TOKEN
      ? 'A join token is configured; starting the daemon will enroll.'
      : 'No session and no join token — this node cannot authenticate. Re-run the install one-liner (repair mode).',
  };
}

async function checkMesh(ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'mesh', title: 'Mesh (netbird)' };
  if (!env.ALLOW_MESH) return { ...base, status: 'skip', detail: 'disabled on this node (SWARMY_ALLOW_MESH=false)' };

  const state = await sampleMeshState().catch(() => null);
  if (!state) {
    // No mesh client at all. Only a problem if this node was told to have one.
    if (env.MESH_SETUP_KEY || ctx.daemon?.meshConnected) {
      return {
        ...base,
        status: 'fail',
        detail: 'no mesh client running, but this node is mesh-configured',
        fix: {
          title: 'start the mesh client container (swarmy-netbird)',
          danger: 'green',
          apply: async () => {
            await run(['docker', 'start', 'swarmy-netbird']);
            return 'docker start swarmy-netbird issued';
          },
        },
      };
    }
    return { ...base, status: 'skip', detail: 'no mesh client on this node' };
  }
  if (!state.connected) {
    return {
      ...base,
      status: 'fail',
      detail: `${state.driver} client present but NOT connected${state.error ? ` — ${state.error}` : ''}`,
      hint: 'Check `swarmy-agent mesh status` for peer detail. Management URL reachable? Setup key valid?',
    };
  }
  const peers = state.peers ?? [];
  const connectedPeers = peers.filter((p) => p.connected).length;
  const relayed = peers.filter((p) => p.relayed).length;
  const relayNote = relayed > 0 ? `, ${relayed} relayed (direct path blocked — latency will suffer)` : '';
  return {
    ...base,
    status: relayed > 0 ? 'warn' : 'ok',
    detail: `connected as ${state.meshIp ?? '?'} — ${connectedPeers}/${peers.length} peers up${relayNote}`,
  };
}

async function checkSwarm(ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'swarm', title: 'Docker Swarm' };
  const swarm = await ctx.docker.swarmState().catch(() => 'inactive' as const);
  if (swarm !== 'active') {
    return {
      ...base,
      status: swarm === 'pending' || swarm === 'locked' ? 'fail' : 'warn',
      detail: `swarm state: ${swarm}`,
      hint:
        swarm === 'locked'
          ? 'The swarm is autolocked. Run `docker swarm unlock` with the unlock key.'
          : swarm === 'pending'
            ? 'Stuck joining — the manager address may be unreachable from here (mesh down?).'
            : 'Not in a swarm. Once the agent registers, the controller orchestrates the join automatically. ' +
              'If it never happens: `swarmy-agent rejoin`.',
    };
  }

  // Raw dockerode info: DockerInfoLike doesn't carry NodeAddr.
  const raw = (await (ctx.docker.docker.info() as Promise<unknown>).catch(() => null)) as {
    Swarm?: { NodeAddr?: string; ControlAvailable?: boolean };
  } | null;
  const nodeAddr = raw?.Swarm?.NodeAddr ?? '?';
  const role = raw?.Swarm?.ControlAvailable ? 'manager' : 'worker';

  // The mesh-first invariant: when the mesh is up, swarm traffic should ride it.
  const mesh = await sampleMeshState().catch(() => null);
  if (mesh?.connected && mesh.meshIp && nodeAddr !== mesh.meshIp) {
    return {
      ...base,
      status: 'warn',
      detail: `active (${role}) — advertising ${nodeAddr}, but mesh IP is ${mesh.meshIp}`,
      hint:
        'Swarm traffic is NOT on the mesh (joined pre-mesh, or mesh added later). ' +
        'Re-forming the swarm membership on the mesh IP requires a leave+rejoin: `swarmy-agent rejoin --force`.',
    };
  }
  return { ...base, status: 'ok', detail: `active (${role}), advertising ${nodeAddr}` };
}

async function checkWorkloads(ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'workloads', title: 'Workloads' };
  const containers = await ctx.docker.listContainers(true).catch(() => null);
  if (!containers) return { ...base, status: 'skip', detail: 'docker unavailable' };
  const running = containers.filter((c) => c.state === 'running').length;
  const stacks = new Set(
    containers.map((c) => c.labels?.['com.docker.stack.namespace']).filter((s): s is string => Boolean(s)),
  );
  const exited = containers.filter((c) => c.state === 'exited').length;
  return {
    ...base,
    status: 'ok',
    detail: `${running} running container${running === 1 ? '' : 's'} across ${stacks.size} stack${stacks.size === 1 ? '' : 's'}${exited ? ` (${exited} exited)` : ''}`,
  };
}

async function checkDisk(_ctx: Ctx): Promise<CheckResult> {
  const base = { id: 'disk', title: 'Disk space' };
  // `df -P` over /var/lib/docker (or /) — portable, no statfs dependency.
  const target = '/var/lib/docker';
  const out = await run(['df', '-P', target]).catch(() => run(['df', '-P', '/']).catch(() => null));
  if (!out) return { ...base, status: 'skip', detail: 'df unavailable' };
  const line = out.trim().split('\n').at(-1) ?? '';
  const cols = line.split(/\s+/);
  const pct = Number.parseInt(cols[4] ?? '', 10);
  const avail = Number.parseInt(cols[3] ?? '', 10); // KiB
  if (Number.isNaN(pct)) return { ...base, status: 'skip', detail: 'could not parse df output' };
  const availGb = (avail / 1024 / 1024).toFixed(1);
  if (pct >= 95) {
    return {
      ...base,
      status: 'fail',
      detail: `${pct}% used on ${target} (${availGb}GB free) — Docker will start failing writes`,
      hint: 'Free space: `docker system prune` (images/build cache), old logs, unused volumes.',
    };
  }
  if (pct >= 85) return { ...base, status: 'warn', detail: `${pct}% used on ${target} (${availGb}GB free)` };
  return { ...base, status: 'ok', detail: `${pct}% used on ${target} (${availGb}GB free)` };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function unitState(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['systemctl', 'is-active', 'swarmy-agent.service'], { stdout: 'pipe', stderr: 'ignore' });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || null;
  } catch {
    return null; // no systemd (container backend / macOS dev)
  }
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(err.trim() || `${cmd[0]} failed`);
  return out;
}
