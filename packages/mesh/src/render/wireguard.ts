/**
 * Pure WireGuard config rendering for the raw-`wireguard` mesh driver.
 *
 * The agent writes the rendered `wg0.conf` and runs `wg-quick up wg0`. swarmy is
 * the system-of-record for keys/addresses; this module only templates the file
 * (no IO, no keygen here — keygen lives in `keygen.ts` so it stays mockable).
 */

export const WIREGUARD_INTERFACE = 'wg0';
export const WIREGUARD_CONFIG_PATH = '/etc/wireguard/wg0.conf';
export const WIREGUARD_DEFAULT_PORT = 51820;

export interface WireguardPeer {
  publicKey: string;
  endpoint?: string;
  allowedIps: string[];
  persistentKeepalive?: number;
  /** Optional comment rendered above the peer block. */
  name?: string;
}

export interface WireguardInterfaceSpec {
  /** This node's mesh address with mask, e.g. `10.77.0.3/24`. */
  address: string;
  privateKey: string;
  listenPort?: number;
  dns?: string[];
  peers: WireguardPeer[];
}

/**
 * Render a deterministic `wg0.conf`. Peers are emitted in input order; callers
 * sort upstream if a stable golden is needed. Lines use `\n` and the file ends
 * with a trailing newline (matches `wg-quick` expectations + golden tests).
 */
export function renderWireguardConfig(spec: WireguardInterfaceSpec): string {
  const lines: string[] = [];
  lines.push('[Interface]');
  lines.push(`Address = ${spec.address}`);
  lines.push(`PrivateKey = ${spec.privateKey}`);
  lines.push(`ListenPort = ${spec.listenPort ?? WIREGUARD_DEFAULT_PORT}`);
  if (spec.dns && spec.dns.length) lines.push(`DNS = ${spec.dns.join(', ')}`);

  for (const peer of spec.peers) {
    lines.push('');
    if (peer.name) lines.push(`# ${peer.name}`);
    lines.push('[Peer]');
    lines.push(`PublicKey = ${peer.publicKey}`);
    if (peer.allowedIps.length) lines.push(`AllowedIPs = ${peer.allowedIps.join(', ')}`);
    if (peer.endpoint) lines.push(`Endpoint = ${peer.endpoint}`);
    if (peer.persistentKeepalive != null) {
      lines.push(`PersistentKeepalive = ${peer.persistentKeepalive}`);
    }
  }
  return lines.join('\n') + '\n';
}
