/**
 * Renders the live node-install script served at `GET /install.sh`.
 * The controller bakes in its own public URL so the agent connects back
 * correctly. The join token is supplied by the operator via the env in the
 * one-liner (`… | SWARMY_JOIN_TOKEN=swt_… sh`) — never via the URL, so it stays
 * out of proxy/CDN access logs.
 *
 * MVP of the node-onboarding epic (see plans/epic-node-onboarding.md). Deferred:
 * checksum-pinned two-stage loader, .deb/.rpm packages, manager-vs-worker
 * auto-detection, uninstall.
 */
export function renderInstallScript(controllerUrl: string): string {
  const agentImage = process.env.SWARMY_AGENT_IMAGE ?? 'ghcr.io/requestflo/swarmy-agent:latest';
  return `#!/usr/bin/env sh
# swarmy node installer
#
#   curl -fsSL ${controllerUrl}/install.sh | SWARMY_JOIN_TOKEN=swt_xxx sh
#
# Installs Docker (if missing), then runs the swarmy agent which dials out to
# your controller over an authenticated WebSocket and registers this node.
set -eu

CONTROLLER_URL="\${SWARMY_CONTROLLER_URL:-${controllerUrl}}"
JOIN_TOKEN="\${SWARMY_JOIN_TOKEN:-}"
AGENT_IMAGE="\${SWARMY_AGENT_IMAGE:-${agentImage}}"
STATE_VOLUME="\${SWARMY_STATE_VOLUME:-swarmy-agent}"

say() { printf '\\033[38;5;209m▸\\033[0m %s\\n' "$1"; }
die() { printf '\\033[31m✗ %s\\033[0m\\n' "$1" >&2; exit 1; }

[ -n "$JOIN_TOKEN" ] || die "Set SWARMY_JOIN_TOKEN (mint one in the dashboard → Settings → Join tokens)."

# Derive the agent WebSocket URL from the controller URL (http→ws, https→wss).
case "$CONTROLLER_URL" in
  https://*) WS_URL="wss://\${CONTROLLER_URL#https://}/agent/ws" ;;
  http://*)  WS_URL="ws://\${CONTROLLER_URL#http://}/agent/ws" ;;
  *) die "SWARMY_CONTROLLER_URL must start with http:// or https://" ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  say "Docker not found — installing via get.docker.com…"
  curl -fsSL https://get.docker.com | sh || die "Docker install failed."
fi
docker info >/dev/null 2>&1 || die "Docker is installed but not running (need root? try: sudo sh)."

say "Starting the swarmy agent…"
docker rm -f swarmy-agent >/dev/null 2>&1 || true
docker run -d \\
  --name swarmy-agent \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$STATE_VOLUME":/var/lib/swarmy \\
  -e AGENT_WS_URL="$WS_URL" \\
  -e SWARMY_JOIN_TOKEN="$JOIN_TOKEN" \\
  -e SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json \\
  "$AGENT_IMAGE" >/dev/null || die "Failed to start the agent container."

say "Done. This node should appear ONLINE in your dashboard within a few seconds."
say "Logs: docker logs -f swarmy-agent"
`;
}
