// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The NetBird client download mirror (plans/epic-self-hosted-mesh-and-fleets.md
 * §3.4, M3): the desktop installers for "Connect from your laptop", served by
 * this controller like the agent binaries (/install/bin), so people never need
 * GitHub to join the mesh.
 *
 *   GET /install/netbird/manifest.json   the mirrored files + their sha256
 *   GET /install/netbird/<release file>  one installer (exact listed names only)
 *   GET /install/netbird.sh              `curl … | sh` for the Linux/macOS CLI
 *
 * Every path is under /install/, so the H17 transport policy (HTTPS only,
 * loopback, or the operator's opt-in) applies before these handlers run. The
 * installers are NOT "verified blobs": a browser download checks no sha256, so
 * they never get the plain-HTTP relaxation.
 */
import { Hono } from 'hono';
import { mirroredCliAssets, netbirdClientFilePath, netbirdClientMirror } from '@swarmy/trpc';

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Pure: the CLI installer. Detects OS/arch, downloads the mirrored file from
 * this controller, checks the pinned sha256, installs, then prints the next
 * step (the per-cluster profile + `netbird up` from the app's Access tab).
 * Linux: the CLI tarball → /usr/local/bin + `netbird service install`.
 * macOS: the signed .pkg through `installer`.
 */
export function renderNetbirdInstaller(base: string, assets: readonly { platform: string; file: string; sha256: string }[]): string {
  const b = base.replace(/\/+$/, '');
  const cases = assets
    .filter((a) => /^(linux|macos)-(amd64|arm64)$/.test(a.platform))
    .map((a) => `  ${a.platform}) file=${sq(a.file)}; want=${sq(a.sha256)} ;;`)
    .join('\n');
  return `#!/bin/sh
# NetBird client installer — served by your swarmy controller (${b}).
#   curl -fsSL ${b}/install/netbird.sh | sh
set -eu
BASE=${sq(b)}
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "netbird: unsupported CPU $arch" >&2; exit 1 ;; esac
case "$os" in linux) platform="linux-$arch" ;; darwin) platform="macos-$arch" ;; *) echo "netbird: unsupported OS $os (Windows: download the installer from the app's Access tab)" >&2; exit 1 ;; esac
file=""; want=""
case "$platform" in
${cases || '  none) ;;'}
esac
if [ -z "$file" ]; then echo "netbird: this controller has no mirrored client for $platform; see https://docs.netbird.io/get-started/install" >&2; exit 1; fi
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "netbird: downloading $file from $BASE" >&2
curl -fsSL "$BASE/install/netbird/$file" -o "$tmp/$file"
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$file" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1); fi
if [ "$got" != "$want" ]; then echo "netbird: checksum mismatch (want $want, got $got)" >&2; exit 1; fi
if [ "$os" = linux ]; then
  tar -xzf "$tmp/$file" -C "$tmp" netbird
  $SUDO install -m 0755 "$tmp/netbird" /usr/local/bin/netbird
  $SUDO netbird service install >/dev/null 2>&1 || true
  $SUDO netbird service start >/dev/null 2>&1 || true
else
  $SUDO installer -pkg "$tmp/$file" -target /
fi
echo "netbird: installed. Next, run the two commands on your app's Access tab (netbird profile add …, netbird up …)." >&2
`;
}

/** The routes; mounted at the root next to /install/bin. `baseFor` = the controller URL for this request. */
export function netbirdClientsApp(baseFor: (headers: Headers) => string): Hono {
  const app = new Hono();
  app.get('/install/netbird/manifest.json', (c) => {
    const m = netbirdClientMirror();
    return m ? c.json(m, 200, { 'cache-control': 'no-store' }) : c.text('no NetBird clients mirrored on this controller', 404);
  });
  app.get('/install/netbird/:file{[A-Za-z0-9._-]+}', (c) => {
    const file = c.req.param('file');
    const p = netbirdClientFilePath(file);
    if (!p) return c.text(`no mirrored NetBird client ${file}`, 404);
    return new Response(Bun.file(p), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${file}"`,
        'cache-control': 'public, max-age=86400, immutable',
      },
    });
  });
  app.get('/install/netbird.sh', (c) =>
    c.body(renderNetbirdInstaller(baseFor(c.req.raw.headers), mirroredCliAssets()), 200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'no-store',
    }),
  );
  return app;
}
