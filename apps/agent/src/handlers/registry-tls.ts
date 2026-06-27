/**
 * Registry TLS / insecure-registry node config (epic: git-cicd-registry, PHASE-2).
 *
 * The in-swarm `registry:2` is reachable cluster-wide over the `swarmy` overlay
 * at `swarmy-registry:5000`, never publicly exposed. Two ways nodes can pull
 * from it:
 *
 *  1. **TLS-by-default (recommended).** Once an ingress driver is configured,
 *     front the registry with the existing Caddy/Traefik pipeline so it serves
 *     a real cert. Nothing to configure on the node — dockerd trusts it.
 *
 *  2. **Insecure intra-overlay (hobby / single-node opt-in).** With no ingress
 *     cert, dockerd refuses a plaintext registry unless it is whitelisted in
 *     `/etc/docker/daemon.json`. This is INVASIVE (edits daemon config + needs a
 *     dockerd restart), so it is an explicit opt-in, never the silent default.
 *
 * This module only RENDERS the hint + file content (pure); applying it (writing
 * the file + restarting dockerd) is left to the operator, by design — the agent
 * does not silently reconfigure the Docker daemon.
 */

/** Render the `/etc/docker/daemon.json` fragment whitelisting an insecure registry. */
export function renderInsecureRegistryDaemonJson(registryHost: string): string {
  return JSON.stringify({ 'insecure-registries': [registryHost] }, null, 2) + '\n';
}

/** Human-readable, copy-pasteable setup hint shown in the dashboard / docs. */
export function renderRegistryTlsHint(registryHost = 'swarmy-registry:5000'): string {
  return [
    '# Option A — TLS (recommended): front the registry with your ingress driver.',
    '#   No per-node config; dockerd trusts the issued certificate.',
    '#',
    '# Option B — insecure intra-overlay (single-node / hobby opt-in only):',
    `#   On every node, merge into /etc/docker/daemon.json then restart dockerd:`,
    renderInsecureRegistryDaemonJson(registryHost).trimEnd(),
    '#   sudo systemctl restart docker',
  ].join('\n');
}
