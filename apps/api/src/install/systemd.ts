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
ExecStart=${binaryPath}
Restart=on-failure
RestartSec=5
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
