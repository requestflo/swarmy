#!/usr/bin/env bash
# Build .deb + .rpm packages for the swarmy node agent via nfpm.
# Node-onboarding epic, PHASE-2+.
#
# UNVERIFIED in this environment: requires `bun`, `nfpm`, and a Linux toolchain
# to compile the agent binary. Run on a release runner. Outputs to ./dist/pkg.
#
# Usage:
#   PKG_VERSION=1.2.3 scripts/package-agent.sh            # both arches
#   PKG_VERSION=1.2.3 PKG_ARCHES="amd64" scripts/package-agent.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKG_VERSION="${PKG_VERSION:-0.0.0}"
PKG_ARCHES="${PKG_ARCHES:-amd64 arm64}"
OUT="${OUT:-dist/pkg}"

command -v nfpm >/dev/null 2>&1 || { echo "nfpm not found (https://nfpm.goreleaser.com)" >&2; exit 1; }
command -v bun >/dev/null 2>&1  || { echo "bun not found" >&2; exit 1; }

mkdir -p "$OUT" packaging

# Render the systemd unit + helper scripts the package ships.
gen_packaging() {
  cat > packaging/swarmy-agent.service <<'EOF'
[Unit]
Description=swarmy node agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/swarmy/agent.env
Environment=SWARMY_AGENT_STATE=/var/lib/swarmy/agent.json
ExecStart=/usr/local/bin/swarmy-agent
Restart=always
RestartSec=5
StateDirectory=swarmy
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  cat > packaging/agent.env.example <<'EOF'
# Fill these in, then: systemctl enable --now swarmy-agent
AGENT_WS_URL=wss://app.swarmy.dev/agent/ws
SWARMY_JOIN_TOKEN=
SWARMY_NODE_LABELS=
EOF

  cat > packaging/postinstall.sh <<'EOF'
#!/bin/sh
set -e
systemctl daemon-reload >/dev/null 2>&1 || true
echo "swarmy-agent installed. Edit /etc/swarmy/agent.env then: systemctl enable --now swarmy-agent"
EOF

  cat > packaging/preremove.sh <<'EOF'
#!/bin/sh
set -e
systemctl disable --now swarmy-agent >/dev/null 2>&1 || true
EOF
  chmod +x packaging/postinstall.sh packaging/preremove.sh
}

bun_arch() { case "$1" in amd64) echo x64 ;; arm64) echo arm64 ;; *) echo "$1" ;; esac; }

gen_packaging

for arch in $PKG_ARCHES; do
  barch="$(bun_arch "$arch")"
  echo "==> building agent binary (linux-$barch)"
  AGENT_BINARY="dist/swarmy-agent-linux-$barch"
  bun build --compile --target "bun-linux-$barch" apps/agent/src/index.ts --outfile "$AGENT_BINARY"

  for pkg in deb rpm; do
    echo "==> nfpm $pkg ($arch)"
    PKG_ARCH="$arch" PKG_VERSION="$PKG_VERSION" AGENT_BINARY="$AGENT_BINARY" \
      nfpm package --config nfpm.yaml --packager "$pkg" --target "$OUT/"
  done
done

echo "==> packages written to $OUT"
ls -la "$OUT"
