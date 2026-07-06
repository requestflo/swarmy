import { describe, expect, it } from 'bun:test';
import {
  renderSystemdUnit,
  renderAgentEnvFile,
  DEFAULT_BINARY_PATH,
  DEFAULT_ENV_FILE,
} from './systemd';
import { renderInstaller } from './installer';

const GOLDEN_UNIT = `[Unit]
Description=swarmy node agent
Documentation=https://swarmy.dev/docs/nodes
# The agent manages Docker; wait for the daemon (swarm init needs it live).
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
EnvironmentFile=/etc/swarmy/agent.env
Environment=SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json
ExecStart=/usr/local/bin/swarmy-agent
# always (not on-failure): the agent exits ON PURPOSE after a self-update swap
# (and the swarm watchdog exits cleanly too) — systemd must bring it back up.
Restart=always
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

describe('renderSystemdUnit (golden)', () => {
  it('matches the golden unit with defaults', () => {
    const unit = renderSystemdUnit({ binaryPath: DEFAULT_BINARY_PATH, envFilePath: DEFAULT_ENV_FILE });
    expect(unit).toBe(GOLDEN_UNIT);
  });

  it('honors a custom user + binary path', () => {
    const unit = renderSystemdUnit({
      binaryPath: '/opt/swarmy/agent',
      envFilePath: '/etc/swarmy/agent.env',
      user: 'swarmy',
    });
    expect(unit).toContain('User=swarmy');
    expect(unit).toContain('ExecStart=/opt/swarmy/agent');
  });

  it('always waits for docker.service (swarm init needs the daemon)', () => {
    const unit = renderSystemdUnit({ binaryPath: DEFAULT_BINARY_PATH, envFilePath: DEFAULT_ENV_FILE });
    expect(unit).toContain('After=network-online.target docker.service');
    expect(unit).toContain('Restart=always');
  });
});

describe('renderAgentEnvFile', () => {
  it('writes ws url + token + labels', () => {
    const env = renderAgentEnvFile({
      wsUrl: 'wss://app.swarmy.dev/agent/ws',
      joinToken: 'swt_abc',
      nodeLabels: 'role=web',
    });
    expect(env).toContain('AGENT_WS_URL=wss://app.swarmy.dev/agent/ws');
    expect(env).toContain('SWARMY_JOIN_TOKEN=swt_abc');
    expect(env).toContain('SWARMY_NODE_LABELS=role=web');
  });

  it('omits token/labels when absent', () => {
    const env = renderAgentEnvFile({ wsUrl: 'wss://x/agent/ws' });
    expect(env).not.toContain('SWARMY_JOIN_TOKEN');
    expect(env).not.toContain('SWARMY_NODE_LABELS');
  });
});

describe('renderInstaller backend selection', () => {
  const base = {
    controllerUrl: 'https://app.swarmy.dev',
    version: '1.0.0',
    agentImage: 'ghcr.io/swarmy/agent:1.0.0',
    binaryBaseUrl: 'https://app.swarmy.dev/install/1.0.0/agent',
    binarySha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'b'.repeat(64) },
  };

  it('embeds both the systemd unit and the docker fallback', () => {
    const sh = renderInstaller(base);
    expect(sh).toContain('install_systemd()');
    expect(sh).toContain('install_docker()');
    expect(sh).toContain('SWARMY_UNIT_EOF');
    expect(sh).toContain('docker run -d');
  });

  it('selects systemd when present, docker otherwise (auto)', () => {
    const sh = renderInstaller(base);
    expect(sh).toContain('use_systemd()');
    expect(sh).toContain('/run/systemd/system');
  });

  it('pins a per-platform binary checksum and verifies the download', () => {
    const sh = renderInstaller(base);
    expect(sh).toContain('linux-x64) echo "' + 'a'.repeat(64) + '"');
    expect(sh).toContain('linux-arm64) echo "' + 'b'.repeat(64) + '"');
    expect(sh).toContain('checksum mismatch');
  });

  it('supports --uninstall for both backends', () => {
    const sh = renderInstaller(base);
    expect(sh).toContain('--uninstall');
    expect(sh).toContain('systemctl disable --now');
    expect(sh).toContain('docker rm -f');
  });
});
