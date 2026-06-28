import os from 'node:os';
import { AGENT_VERSION } from '@swarmy/core';
import { PROTOCOL_VERSION, type NodeFacts, type RegisterPayload } from '@swarmy/core/protocol';
import { DockerClient } from '@swarmy/core/docker';
import { env } from './env';
import { loadState, saveState, type AgentState } from './state';
import { AgentConnection } from './connection';
import { collectMetrics } from './stats';
import { sendContainerList, sendServiceState } from './snapshots';
import { sampleMeshState } from './handlers/mesh';
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

  const startedAt = Date.now();
  let heartbeatSeq = 0;
  let timers: ReturnType<typeof setInterval>[] = [];

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

    void sendContainerList(docker, conn);
    void sendServiceState(docker, conn);

    timers.push(
      setInterval(() => {
        conn.send('heartbeat', {
          seq: heartbeatSeq++,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          inflightCommands: 0,
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
      }, 4_000),
    );
    // Live mesh-state reporter (epic #6, Phase 2+) — periodic telemetry feeding
    // the controller's MeshPeer reconcile. No-op when no mesh client is running.
    void reportMeshState(conn);
    timers.push(setInterval(() => void reportMeshState(conn), 20_000));
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
