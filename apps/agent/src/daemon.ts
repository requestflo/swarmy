import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import { PROTOCOL_VERSION, type NodeFacts, type RegisterPayload, type RenderedMesh } from '@swarmy/core/protocol';
import { DockerClient } from '@swarmy/core/docker';
import { env } from './env';
import { clearState, loadState, saveState, type AgentState } from './state';
import { AgentConnection, strandedShouldExit } from './connection';
import { collectMetrics } from './stats';
import { sendContainerList, sendServiceState, sendNodeList } from './snapshots';
import { applyMesh, lastSampledMeshCidr, sampleMeshState } from './handlers/mesh';
import { checkOverlayKeying, ensureMeshPin } from './handlers/mesh-pin';
import { swarmRejoinInFlight } from './handlers/swarm';
import { superviseMeshControl } from './handlers/mesh-control';
import { detectPublicIp, setObservedPublicIp } from './public-ip';
import { sampleIngressStatus } from './handlers/ingress-status';
import { agentPackaging } from './handlers/update';
import { REGISTRY_FIREWALL_INTERVAL_MS, enforceRegistryFirewall, parseAllowCidrs } from './handlers/registry-firewall';
import { COMMIT, VERSION, versionInfo } from './version';
import { handleCommand } from './executor';
import { startLocalSocket, type DaemonStatus } from './local-socket';

/** Push a `meshState` telemetry frame if a mesh client is running on this node. */
async function reportMeshState(
  conn: AgentConnection,
  onAddressed?: (meshIp: string) => void,
): Promise<void> {
  if (!env.ALLOW_MESH) return;
  try {
    const state = await sampleMeshState();
    if (state) conn.send('meshState', state);
    // Keep the register facts current: a re-register (rejoin, redial) must carry
    // the mesh IP as it is NOW, not as it was at startup (QA-063).
    if (state?.connected && state.meshIp) onAddressed?.(state.meshIp);
    // QA-059: keep the swarm on the mesh across reboots (+ heal if it wasn't).
    if (state?.driver === 'netbird' && state.connected) {
      const docker = new DockerClient(env.DOCKER_SOCKET);
      await ensureMeshPin(docker, lastSampledMeshCidr(), log).catch(() => undefined);
      await checkOverlayKeying(docker, state.meshIp, log).catch(() => undefined);
    }
  } catch {
    // mesh client not present / not ready
  }
}

/**
 * Mesh-first join (epic: zero-trust-networking). When the install one-liner
 * carried an embedded NetBird setup key, join the mesh and confirm
 * connectivity BEFORE registering — so the controller can advertise this
 * node's mesh IP for swarm formation instead of falling back to its LAN
 * address. An already-connected mesh client is reported even without a key
 * (installer node #1). Dormant unless `ALLOW_MESH` is set. Never throws: mesh failure must never block the
 * node from registering/joining the swarm over LAN (fail open).
 */
/** Poll until the mesh client is connected AND addressed; the IP, or undefined at the deadline. */
async function waitForMeshAddress(ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = await sampleMeshState().catch(() => null);
    if (state?.connected && state.meshIp) return state.meshIp;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return undefined;
}

async function joinMeshAtStartup(docker: DockerClient): Promise<{ meshIp?: string; meshConnected?: boolean }> {
  if (!env.ALLOW_MESH) return {};

  try {
    // Idempotency first: if a mesh client is already connected (daemon
    // restart, reboot with the netbird container's restart policy, rejoin
    // flow), REUSE it. Recreating the container would discard the enrolled
    // peer identity and re-present a consumed single-use setup key — the
    // exact failure that used to strand rebooted nodes on their LAN IP.
    const existing = await sampleMeshState().catch(() => null);
    if (existing?.connected) {
      // Connected is not addressed: wait for the IP (QA-063), never re-join.
      const meshIp = existing.meshIp ?? (await waitForMeshAddress(15_000));
      if (!meshIp) {
        log(`mesh already connected (${existing.driver}) but has no address yet — registering without a mesh IP`);
        return {};
      }
      log(`mesh already connected (${existing.driver}, ${meshIp}) — reusing`);
      return { meshIp, meshConnected: true };
    }
    // No key ⇒ nothing to join. (Node #1 from the installer lands above: the
    // installer joins the mesh itself before `swarm init` on the mesh IP.)
    if (!env.MESH_SETUP_KEY) return {};

    const rendered: RenderedMesh = {
      driver: env.MESH_DRIVER as RenderedMesh['driver'],
      action: 'join',
      client: {
        kind: 'netbird',
        setupKey: env.MESH_SETUP_KEY,
        managementUrl: env.MESH_MANAGEMENT_URL || undefined,
        interface: 'wt0',
        advertiseRoutes: [],
        acceptRoutes: true,
        ...(env.MESH_CA_B64 ? { caPem: Buffer.from(env.MESH_CA_B64, 'base64').toString('utf8') } : {}),
      },
      summary: 'mesh-first join at agent startup',
    };
    log('joining mesh before registering…');
    await applyMesh(docker, rendered);

    const meshIp = await waitForMeshAddress(15_000);
    if (meshIp) {
      log(`mesh connected (${env.MESH_DRIVER}, ${meshIp})`);
      return { meshIp, meshConnected: true };
    }
    log('mesh join did not confirm connectivity and an address within 15s — proceeding without a mesh IP');
    return {};
  } catch (err) {
    log('mesh-first join failed — proceeding without a mesh IP:', err instanceof Error ? err.message : err);
    return {};
  }
}

/**
 * Persist the session credential until the write is CONFIRMED on disk.
 * Fire-and-forget (`void saveState`) once left a rebooted node with no
 * `agent.json` and only a consumed single-use join token — permanently
 * offline (see docs/RUNBOOK). Retries with backoff and verifies by re-reading;
 * failure is loud in the journal, and retried on a timer until it lands.
 */
async function persistSession(state: AgentState): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await saveState(state);
      const readBack = await loadState();
      if (readBack && readBack.nodeId === state.nodeId && readBack.sessionSecret === state.sessionSecret) {
        return true;
      }
      throw new Error('read-back mismatch');
    } catch (err) {
      log(
        `WARNING: failed to persist session credential (attempt ${attempt}/5): ` +
          `${err instanceof Error ? err.message : err} — this node would NOT survive a reboot`,
      );
      await new Promise((r) => setTimeout(r, attempt * 1_000));
    }
  }
  return false;
}

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log('[swarmy-agent]', ...args);
}

/** Controller HTTP base derived from the WS URL (ws://h:p/agent/ws → http://h:p). */
function controllerHttpBaseFromWs(wsUrl: string): string {
  const url = new URL(wsUrl);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

export async function runDaemon(): Promise<void> {
  const docker = new DockerClient(env.DOCKER_SOCKET);
  let state: AgentState | null = await loadState();
  const startedAt = Date.now();

  // Registry firewall floor: independent of the controller link (a node must
  // never expose :5000/:5001, connected or not) and re-asserted on a timer
  // because netfilter rules do not survive a reboot.
  let lastFirewallStatus = '';
  const firewallTick = async () => {
    const r = await enforceRegistryFirewall(docker, {
      enabled: env.REGISTRY_FIREWALL,
      packaging: agentPackaging(),
      allowCidrs: parseAllowCidrs(env.REGISTRY_FIREWALL_ALLOW),
    });
    const line = `${r.status}${r.detail ? `: ${r.detail}` : ''}`;
    if (r.status !== 'unchanged' && line !== lastFirewallStatus) log(`registry firewall ${line}`);
    lastFirewallStatus = line;
  };
  void firewallTick();
  const firewallTimer = setInterval(() => void firewallTick(), REGISTRY_FIREWALL_INTERVAL_MS);

  // Self-hosted mesh control plane (when this node holds one): keep it up and
  // its tmpfs config present, BEFORE and regardless of the controller
  // connection — on a cold boot the controller is reached over the overlay,
  // which rides the mesh this container serves.
  let lastMeshControl = '';
  const meshControlTick = async () => {
    const st = await superviseMeshControl(docker);
    if (!st) return;
    const line = st.error ? `error: ${st.error}` : st.healthy ? 'healthy' : st.waitingForConfig ? 'waiting for config' : 'starting';
    if (line !== lastMeshControl) log(`mesh control plane ${line}`);
    lastMeshControl = line;
  };
  void meshControlTick();
  const meshControlTimer = setInterval(() => void meshControlTick(), 10_000);

  // Live diagnostics surface for the local CLI (status/doctor/reconnect over
  // the unix socket). Everything here is what the daemon KNOWS — the CLI
  // combines it with its own docker/mesh probes.
  const runtime = {
    sessionPersisted: state != null,
    lastAckAt: null as number | null,
    lastAuthReject: null as { code: number; reason: string; at: number } | null,
    authRejects: 0,
  };

  // ── recovery beacon (self-healing epic) ────────────────────────────────────
  // Every credential is dead (session gone/rejected AND the join token
  // rejected repeatedly) → device-pairing mode: post a claim, print a
  // fingerprint for the operator to verify in the dashboard, poll until
  // approved, then resume as our old node identity. See recovery.service.ts
  // for the trust model.
  let beacon: ReturnType<typeof setInterval> | null = null;
  function maybeStartRecoveryBeacon(): void {
    if (beacon || runtime.authRejects < 4) return;
    const claimSecret = randomBytes(32).toString('base64url');
    const claimHash = createHash('sha256').update(claimSecret).digest('hex');
    const fingerprint = `${claimHash.slice(0, 4)}-${claimHash.slice(4, 8)}`.toUpperCase();
    const base = controllerHttpBaseFromWs(env.AGENT_WS_URL);
    let claimId: string | null = null;

    log('────────────────────────────────────────────────────────────');
    log('RECOVERY MODE: this node cannot authenticate with any credential.');
    log(`A recovery claim is being posted. In the dashboard (Infrastructure),`);
    log(`approve the claim for "${os.hostname()}" ONLY IF its fingerprint is:`);
    log(`    ${fingerprint}`);
    log('────────────────────────────────────────────────────────────');

    const tick = async (): Promise<void> => {
      try {
        if (!claimId) {
          const res = await fetch(`${base}/agent/recovery/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hostname: os.hostname(), claimHash }),
            signal: AbortSignal.timeout(5_000),
          });
          const body = (await res.json()) as { accepted?: boolean; claimId?: string };
          if (body.claimId) claimId = body.claimId;
          else if (body.accepted) log('recovery claim submitted — waiting for it to be matched to a known node…');
          return;
        }
        const res = await fetch(`${base}/agent/recovery/poll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claimId, claimSecret }),
          signal: AbortSignal.timeout(5_000),
        });
        const body = (await res.json()) as
          | { status: 'pending' | 'denied' | 'expired' | 'unknown' }
          | { status: 'approved'; nodeId: string; sessionSecret: string; sessionVersion: number };
        if (body.status === 'approved') {
          log(`recovery approved — resuming as node ${body.nodeId}`);
          state = { nodeId: body.nodeId, sessionSecret: body.sessionSecret, sessionVersion: body.sessionVersion };
          runtime.sessionPersisted = false;
          const persisted = await persistSession(state);
          if (persisted) runtime.sessionPersisted = true;
          stopBeacon();
          runtime.authRejects = 0;
          conn.redial();
        } else if (body.status === 'denied') {
          log('recovery claim DENIED by the operator — staying offline (check the dashboard).');
          stopBeacon();
        } else if (body.status === 'expired' || body.status === 'unknown') {
          claimId = null; // re-post a fresh claim on the next tick
        }
      } catch {
        // controller unreachable — keep beaconing
      }
    };
    beacon = setInterval(() => void tick(), 15_000);
    void tick();
  }
  function stopBeacon(): void {
    if (beacon) clearInterval(beacon);
    beacon = null;
  }

  if (!state && !env.JOIN_TOKEN) {
    log('no saved session and no SWARMY_JOIN_TOKEN set — set one to enroll this node');
  }

  let facts: NodeFacts;
  try {
    // VERSION is the release-stamped package.json version — the same string
    // `--version` prints and the update manifest carries.
    facts = await docker.getNodeFacts(VERSION, [PROTOCOL_VERSION]);
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
      agentVersion: VERSION,
      protocolVersions: [PROTOCOL_VERSION],
    };
  }

  // Compiled host binary vs interpreted container — the controller picks the
  // matching updateAgent strategy (self-replace vs docker-recreate) from this.
  facts.agentPackaging = agentPackaging();
  // Build commit on EVERY path (not just the no-docker fallback): unreleased
  // builds are all 0.0.0, so this is what the controller's update check compares.
  facts.agentCommit = COMMIT;

  // Explicit SWARMY_ALLOW_BUILD override (if any) — lets the controller's
  // builder picker honour a local allow/veto instead of dispatching blind.
  if (env.BUILD_OVERRIDE) facts.buildOverride = env.BUILD_OVERRIDE;
  // Same for the terminal capabilities, so the dashboard can say "blocked
  // locally by SWARMY_ALLOW_EXEC=false on this node" instead of failing blind.
  if (env.EXEC_OVERRIDE) facts.execOverride = env.EXEC_OVERRIDE;
  if (env.SHELL_OVERRIDE) facts.shellOverride = env.SHELL_OVERRIDE;

  // Public IP for the geo-edge DNS layer: the controller reports the source
  // address it sees in registerAck (preferred); third-party echo services are
  // only a heartbeat-time fallback when it saw a private path. So the first
  // register carries no self-detected IP and startup makes no outbound call.

  // Mesh-first join: resolve BEFORE the WS connection opens so the very first
  // `register` call already carries the mesh IP (see joinMeshAtStartup above).
  const mesh = await joinMeshAtStartup(docker);
  facts.meshIp = mesh.meshIp;
  facts.meshConnected = mesh.meshConnected;

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
    // A deliberate leave→join re-pin (mesh migration) is not "fell off".
    if (swarmRejoinInFlight()) return;
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
      runtime.lastAckAt = Date.now();
      runtime.lastAuthReject = null;
      runtime.authRejects = 0;
      stopBeacon();
      runtime.sessionPersisted = false;
      const toPersist = state;
      void persistSession(toPersist).then((persisted) => {
        // Only stamp persisted when the credential we wrote is still current —
        // a re-register can race a slow retry loop.
        if (persisted && state?.sessionSecret === toPersist.sessionSecret) runtime.sessionPersisted = true;
      });
      log(`registered as node ${payload.nodeId}`);
      setObservedPublicIp(payload.observedPublicIp);
      if (payload.observedPublicIp && facts.publicIp !== payload.observedPublicIp) {
        facts.publicIp = payload.observedPublicIp;
        log(`public ip (as the controller sees it): ${payload.observedPublicIp}`);
      }
      startLoops(payload.heartbeatIntervalMs, payload.metricsIntervalMs);
    },
    onCommand: (envlp) => {
      void handleCommand(docker, conn, envlp).catch((e) => {
        log(`command ${envlp.type} threw outside its result handler: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    onStranded: (downForMs) => {
      // A container agent's overlay endpoint doesn't heal by redialing (the
      // veths stay NO-CARRIER after the controller task died): exit so the
      // restart policy recycles the container with a fresh attachment. A
      // host binary keeps redialing (its path is the host network).
      const mins = Math.round(downForMs / 60_000);
      if (strandedShouldExit(agentPackaging())) {
        log(`no live controller link for ${mins} min — exiting so the restart policy recycles this container (fresh overlay endpoint)`);
        setTimeout(() => process.exit(1), 250);
      } else {
        log(`no live controller link for ${mins} min — still redialing`);
      }
    },
    onAuthRejected: (code, reason) => {
      runtime.lastAuthReject = { code, reason, at: Date.now() };
      runtime.authRejects += 1;
      // A rotated-but-unacked session secret (controller crash mid-register)
      // otherwise dead-loops forever. Drop the session; if a join token is
      // present the next dial re-enrolls, which upserts the SAME node row
      // (keyed org+hostname) — identity is preserved.
      if (state && env.JOIN_TOKEN) {
        log(`controller rejected our session (${code} ${reason}) — re-enrolling with the join token`);
        state = null;
        void clearState();
      } else if (state) {
        log(`controller rejected our session (${code} ${reason}) and no SWARMY_JOIN_TOKEN is set — cannot re-enroll`);
      }
      // Session AND token paths both rejected repeatedly → last resort.
      maybeStartRecoveryBeacon();
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
          if (publicIp) facts.publicIp = publicIp;
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
    const refreshMeshFacts = (meshIp: string) => {
      facts.meshIp = meshIp;
      facts.meshConnected = true;
    };
    void reportMeshState(conn, refreshMeshFacts);
    timers.push(setInterval(() => void reportMeshState(conn, refreshMeshFacts), 20_000));

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

  // Local diagnostics socket for the swarmy-agent CLI (status/doctor/
  // reconnect). Failure to bind must never take the daemon down.
  const buildStatus = (): DaemonStatus => {
    const v = versionInfo();
    return {
      version: v.version,
      commit: v.commit,
      protocolVersion: v.protocolVersion,
      pid: process.pid,
      startedAt,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      wsUrl: env.AGENT_WS_URL,
      connected: conn.connected,
      nodeId: state?.nodeId ?? null,
      sessionVersion: state?.sessionVersion ?? null,
      sessionPersisted: runtime.sessionPersisted,
      lastAckAt: runtime.lastAckAt,
      lastAuthReject: runtime.lastAuthReject,
      hostname: facts.hostname,
      meshIp: facts.meshIp ?? null,
      meshConnected: facts.meshConnected ?? false,
      hasJoinToken: Boolean(env.JOIN_TOKEN),
    };
  };
  const localSocket = startLocalSocket({
    socketPath: env.SOCKET_PATH,
    getStatus: buildStatus,
    reconnect: () => conn.redial(),
    log,
  });

  conn.start();
  log(`connecting to ${env.AGENT_WS_URL} as ${facts.hostname}`);

  const shutdown = () => {
    for (const t of timers) clearInterval(t);
    clearInterval(firewallTimer);
    clearInterval(meshControlTimer);
    stopBeacon();
    localSocket?.stop();
    conn.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
