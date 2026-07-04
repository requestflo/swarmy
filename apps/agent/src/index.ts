import os from 'node:os';
import { AGENT_VERSION } from '@swarmy/core';
import { PROTOCOL_VERSION, type NodeFacts, type RegisterPayload } from '@swarmy/core/protocol';
import { DockerClient } from '@swarmy/core/docker';
import { env } from './env';
import { loadState, saveState, type AgentState } from './state';
import { AgentConnection } from './connection';
import { collectMetrics } from './stats';
import { sendContainerList, sendServiceState, sendNodeList } from './snapshots';
import { sampleMeshState } from './handlers/mesh';
import { detectPublicIp } from './public-ip';
import { sampleIngressStatus } from './handlers/ingress-status';
import { handleCommand } from './executor';

/** Push a `meshState` telemetry frame if a mesh client is running on this node. */
async function reportMeshState(conn: AgentConnection): Promise<void> {
  if (!env.ALLOW_MESH) return;
  try {
    const state = await sampleMeshState();
    if (state) conn.send('meshState', state);
  } catch {
    // mesh client not present / not ready
  }
}

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[swarmy-agent]', ...args);
}

async function main(): Promise<void> {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    const { versionInfo } = await import('./version');
    const v = versionInfo();
    // eslint-disable-next-line no-console
    console.log(`swarmy-agent ${v.version} (protocol ${v.protocolVersion}, commit ${v.commit})`);
    process.exit(0);
  }
  const docker = new DockerClient(env.DOCKER_SOCKET);
  let state: AgentState | null = await loadState();

  if (!state && !env.JOIN_TOKEN) {
    log('no saved session and no SWARMY_JOIN_TOKEN set — set one to enroll this node');
  }

  let facts: NodeFacts;
  try {
    facts = await docker.getNodeFacts(AGENT_VERSION, [PROTOCOL_VERSION]);
  } catch {
    log('docker unavailable — reporting node facts from the OS only');
    facts = {
      hostname: os.hostname(),
      os: os.type(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      memTotalBytes: os.totalmem(),
      dockerVersion: 'unknown',
      swarmRole: 'none',
      agentVersion: AGENT_VERSION,
      protocolVersions: [PROTOCOL_VERSION],
    };
  }

  // Public IP for the geo-edge DNS layer: detected outbound, sent with register
  // + every heartbeat (detector caches hourly). Never blocks startup.
  facts.publicIp = await detectPublicIp();
  if (facts.publicIp) log(`public ip detected: ${facts.publicIp}`);

  const startedAt = Date.now();
  let heartbeatSeq = 0;
  let timers: ReturnType<typeof setInterval>[] = [];

  // Swarm-membership watchdog. The agent is useless off-swarm — it can't run a
  // single Docker Swarm command — so if the swarm is LEFT out from under a
  // running agent (operator ran `docker swarm leave`, or the node was removed),
  // fail loudly and exit. That drops the node offline / lets the container
  // restart, instead of lingering as a phantom healthy member.
  //
  // We only exit AFTER seeing the swarm active at least once: a freshly-enrolling
  // node legitimately starts off-swarm and waits for the controller's `swarmJoin`
  // command, so an active→inactive transition (not "never joined") is the signal.
  let swarmEverActive = false;
  async function swarmWatchdog(): Promise<void> {
    let swarm: Awaited<ReturnType<DockerClient['swarmState']>>;
    try {
      swarm = await docker.swarmState();
    } catch {
      swarm = 'inactive';
    }
    if (swarm === 'active') {
      swarmEverActive = true;
      return;
    }
    if (swarmEverActive) {
      log(
        `FATAL: this node left the swarm (docker swarm state: ${swarm}). The ` +
          `swarmy agent cannot run off-swarm — exiting so the node drops offline ` +
          `and the container restarts once it has rejoined a swarm.`,
      );
      for (const t of timers) clearInterval(t);
      // Tell the controller BEFORE we go, so it can react intentionally (mark the
      // node left-swarm, audit, fan out) rather than inferring it from the drop.
      conn.send('swarmLeft', { at: Date.now(), swarmState: swarm, reason: 'watchdog: docker swarm left' });
      // Give the frame a moment to flush over the socket, then exit.
      setTimeout(() => {
        conn.stop();
        process.exit(1);
      }, 250);
    }
  }

  const buildRegister = (): RegisterPayload => ({
    auth: state
      ? { kind: 'session', nodeId: state.nodeId, sessionSecret: state.sessionSecret }
      : { kind: 'join', joinToken: env.JOIN_TOKEN },
    facts,
  });

  const conn = new AgentConnection({
    url: env.AGENT_WS_URL,
    buildRegister,
    onRegisterAck: (payload) => {
      state = {
        nodeId: payload.nodeId,
        sessionSecret: payload.sessionCredential.sessionSecret,
        sessionVersion: payload.sessionCredential.sessionVersion,
      };
      void saveState(state);
      log(`registered as node ${payload.nodeId}`);
      startLoops(payload.heartbeatIntervalMs, payload.metricsIntervalMs);
    },
    onCommand: (envlp) => {
      void handleCommand(docker, conn, envlp);
    },
  });

  function startLoops(heartbeatMs: number, metricsMs: number): void {
    for (const t of timers) clearInterval(t);
    timers = [];

    void swarmWatchdog();
    void sendContainerList(docker, conn);
    void sendServiceState(docker, conn);
    void sendNodeList(docker, conn);

    // Local swarm-membership check on its own cadence (independent of the
    // controller connection): catches a `docker swarm leave` within ~5s.
    timers.push(setInterval(() => void swarmWatchdog(), 5_000));

    timers.push(
      setInterval(() => {
        void detectPublicIp().then((publicIp) => {
          conn.send('heartbeat', {
            seq: heartbeatSeq++,
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            inflightCommands: 0,
            publicIp,
          });
        });
      }, heartbeatMs),
    );
    timers.push(
      setInterval(async () => {
        conn.send('metrics', await collectMetrics(docker));
      }, metricsMs),
    );
    timers.push(
      setInterval(() => {
        void sendContainerList(docker, conn);
        void sendServiceState(docker, conn);
        void sendNodeList(docker, conn);
      }, 4_000),
    );
    // Live mesh-state reporter (epic #6, Phase 2+) — periodic telemetry feeding
    // the controller's MeshPeer reconcile. No-op when no mesh client is running.
    void reportMeshState(conn);
    timers.push(setInterval(() => void reportMeshState(conn), 20_000));

    // Geo-edge health: is this node's Caddy/swarmy-dns task alive? (local docker ps)
    const reportIngressStatus = async () => {
      try {
        conn.send('ingressNodeStatus', await sampleIngressStatus(docker));
      } catch {
        // best-effort telemetry
      }
    };
    void reportIngressStatus();
    timers.push(setInterval(() => void reportIngressStatus(), 30_000));
  }

  conn.start();
  log(`connecting to ${env.AGENT_WS_URL} as ${facts.hostname}`);

  const shutdown = () => {
    for (const t of timers) clearInterval(t);
    conn.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
