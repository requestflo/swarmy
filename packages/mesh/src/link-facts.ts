/**
 * Per-peer link facts from the mesh client's own status (boards 12, 14, 22):
 * how long a round trip takes, whether the link is peer to peer or goes
 * through a relay, and how many bytes went each way. Pure: the agent hands in
 * the client's parsed `status --json`; nothing here runs a command.
 *
 * NetBird, `netbird status --json` (client/status/status.go, v0.79):
 *   peers.details[]: netbirdIp, publicKey, status ("Connected" | "Idle" | …),
 *   connectionType ("P2P" | "Relayed" | "-"), latency (a Go time.Duration, so
 *   integer nanoseconds), transferReceived / transferSent (int64 bytes),
 *   lastWireguardHandshake (RFC 3339; Go's zero time when never). The client
 *   fills connection type, handshake and bytes only for a connected peer.
 * Tailscale (Headscale's client), `tailscale status --json` (ipn/ipnstate):
 *   Peer{key: PeerStatus} with TailscaleIPs, PublicKey, Online, Active,
 *   CurAddr, Relay, PeerRelay, RxBytes, TxBytes, LastHandshake. It carries no
 *   latency (only `tailscale ping` measures one, as text), so a Headscale
 *   link reports its path and bytes and leaves latency out: never a guess.
 */

/** What one end says about its link to one peer. Absent fields are unknown, never zero. */
export interface PeerLinkFacts {
  /** Round trip in milliseconds, as the client measured it. */
  latencyMs?: number;
  /** true = through a relay (still end-to-end encrypted), false = peer to peer. */
  relayed?: boolean;
  /** Bytes received from / sent to this peer since the tunnel came up. */
  rxBytes?: number;
  txBytes?: number;
}

/** One peer this node sees, with its link facts when the client has any. */
export interface PeerLinkSample {
  meshIp?: string;
  publicKey?: string;
  connected: boolean;
  lastHandshakeAt?: string;
  link?: PeerLinkFacts;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
const bare = (ip: string | undefined): string | undefined => (ip ? ip.split('/')[0] || undefined : undefined);

/** A Go time.Duration (ns) → ms, to the microsecond; 0 means "not measured", so it's left out. */
export function durationNsToMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(v / 1_000) / 1_000;
}

/**
 * A Go time.Time from JSON → ISO. Go's zero time ("0001-01-01T00:00:00Z", or
 * year 0 once NetBird's `.Local()` shifts it by a zone's old offset) and junk
 * are left out: anything before 1971 is "never".
 */
export function goTime(v: unknown): string | undefined {
  const s = str(v);
  const t = s ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) || t < Date.UTC(1971, 0, 1) ? undefined : new Date(t).toISOString();
}

/** NetBird's connection type → relayed; "-" (not connected) and anything new stay unknown. */
export function netbirdRelayed(connectionType: unknown): boolean | undefined {
  if (connectionType === 'P2P') return false;
  if (connectionType === 'Relayed') return true;
  return undefined;
}

/** Every peer in a parsed `netbird status --json`, with link facts for the connected ones. */
export function netbirdPeerLinks(status: unknown): PeerLinkSample[] {
  const details = obj(obj(status).peers).details;
  if (!Array.isArray(details)) return [];
  return details.map((raw): PeerLinkSample => {
    const p = obj(raw);
    const connected = p.status === 'Connected';
    const relayed = netbirdRelayed(p.connectionType);
    const latencyMs = durationNsToMs(p.latency);
    const rxBytes = count(p.transferReceived);
    const txBytes = count(p.transferSent);
    const lastHandshakeAt = goTime(p.lastWireguardHandshake);
    return {
      meshIp: bare(str(p.netbirdIp)),
      publicKey: str(p.publicKey),
      connected,
      ...(lastHandshakeAt ? { lastHandshakeAt } : {}),
      ...(connected
        ? {
            link: {
              ...(latencyMs !== undefined ? { latencyMs } : {}),
              ...(relayed !== undefined ? { relayed } : {}),
              ...(rxBytes !== undefined ? { rxBytes } : {}),
              ...(txBytes !== undefined ? { txBytes } : {}),
            },
          }
        : {}),
    };
  });
}

/** The PeerStatus fields Tailscale's relayed reading needs. */
export interface TailscalePeerPath {
  Active?: boolean;
  CurAddr?: string;
  Relay?: string;
  PeerRelay?: string;
}

/**
 * Is this peer's traffic going through a relay right now, the way `tailscale
 * status` prints it: an ACTIVE peer with a direct endpoint (`CurAddr`) is
 * peer to peer; without one it rides DERP (`Relay`) or a peer relay
 * (`PeerRelay`). `undefined` = idle, can't tell.
 */
export function tailscalePeerRelayed(p: TailscalePeerPath): boolean | undefined {
  if (!p.Active) return undefined;
  if (p.CurAddr) return false;
  return Boolean(p.Relay || p.PeerRelay);
}

/** The first IPv4 of a Tailscale address list (else the first). */
export function firstIpv4(ips: unknown): string | undefined {
  if (!Array.isArray(ips)) return undefined;
  const list = ips.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return list.find((ip) => ip.includes('.')) ?? list[0];
}

/** Every peer in a parsed `tailscale status --json`, with link facts for the online ones (no latency). */
export function tailscalePeerLinks(status: unknown): PeerLinkSample[] {
  return Object.values(obj(obj(status).Peer)).map((raw): PeerLinkSample => {
    const p = obj(raw);
    const connected = p.Online === true;
    const relayed = tailscalePeerRelayed(p as TailscalePeerPath);
    const rxBytes = count(p.RxBytes);
    const txBytes = count(p.TxBytes);
    const lastHandshakeAt = goTime(p.LastHandshake);
    return {
      meshIp: firstIpv4(p.TailscaleIPs),
      publicKey: str(p.PublicKey),
      connected,
      ...(lastHandshakeAt ? { lastHandshakeAt } : {}),
      ...(connected
        ? {
            link: {
              ...(relayed !== undefined ? { relayed } : {}),
              ...(rxBytes !== undefined ? { rxBytes } : {}),
              ...(txBytes !== undefined ? { txBytes } : {}),
            },
          }
        : {}),
    };
  });
}

/** The node-level flag: relayed when any link is, direct when every known link is; unknown with none known. */
export function nodeRelayed(peers: readonly PeerLinkSample[]): boolean | undefined {
  const known = peers.flatMap((p) => (p.link?.relayed === undefined ? [] : [p.link.relayed]));
  return known.length ? known.some(Boolean) : undefined;
}
