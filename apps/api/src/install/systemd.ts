/**
 * systemd backend for the node installer (node-onboarding epic, PHASE-2+).
 *
 * Renders a native systemd unit that supervises the swarmy agent binary —
 * the alternative to running the agent as a Docker container. systemd gives us
 * restart-on-crash, boot persistence, journald logs and a clean
 * `systemctl disable --now` uninstall for free, with no daemon code.
 *
 * Pure render (no I/O) so it is golden-testable. The installer shell script
 * writes this to `/etc/systemd/system/swarmy-agent.service`, the env file to
 * `/etc/swarmy/agent.env`, then `systemctl enable --now`.
 */

export interface SystemdUnitOptions {
  /** Absolute path to the installed agent binary. */
  binaryPath: string;
  /** Absolute path to the EnvironmentFile holding SWARMY_JOIN_TOKEN etc. */
  envFilePath: string;
  /** State dir the agent persists its session into (StateDirectory-managed). */
  stateDir?: string;
  /** Unix user to run the agent as (default root — needs the docker socket). */
  user?: string;
}

export const SYSTEMD_UNIT_NAME = 'swarmy-agent.service';
export const SNAPSHOT_UNIT_NAME = 'swarmy-doctor-snapshot.service';
export const DEFAULT_ENV_FILE = '/etc/swarmy/agent.env';
export const DEFAULT_BINARY_PATH = '/usr/local/bin/swarmy-agent';
export const DEFAULT_STATE_DIR = '/var/lib/swarmy';

/** Render the `swarmy-agent.service` unit file (deterministic / golden-tested). */
export function renderSystemdUnit(opts: SystemdUnitOptions): string {
  const binaryPath = opts.binaryPath || DEFAULT_BINARY_PATH;
  const envFilePath = opts.envFilePath || DEFAULT_ENV_FILE;
  const stateDir = opts.stateDir || DEFAULT_STATE_DIR;
  const user = opts.user || 'root';
  return `[Unit]
Description=swarmy node agent
Documentation=https://swarmy.dev/docs/nodes
# The agent manages Docker; wait for the daemon (swarm init needs it live).
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${user}
EnvironmentFile=${envFilePath}
Environment=SWARMY_AGENT_STATE=${stateDir}/agent.json
ExecStart=${binaryPath} daemon
# always (not on-failure): the agent exits ON PURPOSE after a self-update swap
# (and the swarm watchdog exits cleanly too) — systemd must bring it back up.
Restart=always
RestartSec=5
# Capture a doctor snapshot at crash time (last-failure.json) for post-mortems.
OnFailure=${SNAPSHOT_UNIT_NAME}
# Persist the agent's session credential across restarts/reboots.
StateDirectory=swarmy
RuntimeDirectory=swarmy
# Basic hardening (the agent still needs the docker socket, so not fully locked).
NoNewPrivileges=true
ProtectKernelTunables=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Render the `swarmy-doctor-snapshot.service` unit — fired by the agent
 * unit's OnFailure=. Writes a full doctor report to
 * `<stateDir>/last-failure.json` so "why did it crash last night?" has an
 * answer even after journald rotates.
 */
export function renderSnapshotUnit(opts: { binaryPath: string; stateDir?: string }): string {
  const stateDir = opts.stateDir || DEFAULT_STATE_DIR;
  return `[Unit]
Description=swarmy doctor snapshot (captured when swarmy-agent fails)

[Service]
Type=oneshot
ExecStart=/bin/sh -c '${opts.binaryPath} doctor --json > ${stateDir}/last-failure.json 2>&1 || true'
`;
}

/** Render the `/etc/swarmy/agent.env` EnvironmentFile body (deterministic). */
export function renderAgentEnvFile(vars: {
  wsUrl: string;
  joinToken?: string;
  nodeLabels?: string;
  stateDir?: string;
}): string {
  const lines = [
    `AGENT_WS_URL=${vars.wsUrl}`,
    `SWARMY_AGENT_STATE=${vars.stateDir ?? DEFAULT_STATE_DIR}/agent.json`,
  ];
  if (vars.joinToken) lines.push(`SWARMY_JOIN_TOKEN=${vars.joinToken}`);
  if (vars.nodeLabels) lines.push(`SWARMY_NODE_LABELS=${vars.nodeLabels}`);
  return lines.join('\n') + '\n';
}
