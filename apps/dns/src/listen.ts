import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { log, logError } from './config';

/**
 * Per-address listeners (host networking).
 *
 * swarmy-dns runs on the node's HOST network namespace with no published
 * ports. It must NOT bind the wildcard 0.0.0.0:53: on every stock Ubuntu/
 * Debian host systemd-resolved's stub already holds 127.0.0.53:53 and
 * 127.0.0.54:53, and a wildcard bind collides with it ("address already in
 * use"). Instead we enumerate the host's interfaces and bind :53 on every
 * non-loopback, non-link-local address individually. Specific-address binds
 * coexist with resolved, so the host resolver config is never touched.
 *
 * Addresses change (DHCP, a floating IP attached later, IPv6 DAD finishing),
 * so a ListenerSet re-scans periodically: new addresses get bound, vanished
 * ones get closed, and an address whose bind failed is simply retried on the
 * next scan (e.g. a libvirt dnsmasq holding 192.168.122.1:53 never blocks the
 * public address).
 */

type Ifaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const isV4 = (a: NetworkInterfaceInfo): boolean =>
  (a.family as unknown) === 'IPv4' || (a.family as unknown) === 4;

/** IPv6 link-local fe80::/10 (fe80–febf). */
function isV6LinkLocal(address: string): boolean {
  const first = parseInt(address.split(':')[0] || '0', 16);
  return (first & 0xffc0) === 0xfe80;
}

/** IPv6 multicast ff00::/8 (never assigned to an interface, but be safe). */
function isV6Multicast(address: string): boolean {
  return address.toLowerCase().startsWith('ff');
}

/**
 * Public DNS listen addresses: every IPv4 except loopback (127/8) and
 * link-local (169.254/16), every IPv6 except loopback (::1) and link-local
 * (fe80::/10). Sorted + de-duplicated so re-scans are stable. Pure.
 */
export function selectDnsListenAddresses(ifaces: Ifaces): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      const address = a.address.split('%')[0]!;
      if (isV4(a)) {
        if (address.startsWith('127.') || address.startsWith('169.254.')) continue;
      } else {
        const lower = address.toLowerCase();
        if (lower === '::1' || lower === '::' || isV6LinkLocal(lower) || isV6Multicast(lower)) continue;
      }
      out.add(address);
    }
  }
  return [...out].sort();
}

/**
 * Admin API listen addresses — NEVER public. Loopback (the systemd-backend
 * agent shares the host netns and dials 127.0.0.1) plus the docker0 bridge
 * gateway address when present (a container-backend agent on the default
 * bridge reaches the host there). docker0 is host-private: not routable from
 * outside the box. Pure.
 */
export function selectAdminListenAddresses(ifaces: Ifaces): string[] {
  const out = new Set<string>(['127.0.0.1']);
  for (const a of ifaces.docker0 ?? []) {
    if (isV4(a) && !a.internal) out.add(a.address);
  }
  return [...out].sort();
}

/** `SWARMY_DNS_LISTEN`-style comma list → addresses; undefined when unset/empty. */
export function parseListenOverride(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  return list.length ? list : undefined;
}

export const hostInterfaces = (): Ifaces => networkInterfaces();

export interface Closeable {
  close(): void;
}

export interface SyncResult {
  added: string[];
  removed: string[];
  failed: Array<{ address: string; error: string }>;
}

/**
 * A set of listeners keyed by address: `sync()` diffs the resolved address list
 * against what is bound. The bind fn is injected (UDP / TCP / admin) so the
 * diff logic is unit-testable without sockets.
 */
export class ListenerSet {
  private readonly bound = new Map<string, Closeable>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing: Promise<SyncResult> | undefined;

  constructor(
    private readonly label: string,
    private readonly resolve: () => string[],
    private readonly bind: (address: string) => Closeable | Promise<Closeable>,
  ) {}

  addresses(): string[] {
    return [...this.bound.keys()].sort();
  }

  sync(): Promise<SyncResult> {
    // Never overlap two scans (a slow bind must not double-bind an address).
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async doSync(): Promise<SyncResult> {
    const result: SyncResult = { added: [], removed: [], failed: [] };
    let wanted: string[];
    try {
      wanted = this.resolve();
    } catch (err) {
      logError(`${this.label}: interface scan failed:`, err);
      return result;
    }
    const want = new Set(wanted);
    for (const [address, listener] of this.bound) {
      if (want.has(address)) continue;
      try {
        listener.close();
      } catch {
        // already gone with its interface
      }
      this.bound.delete(address);
      result.removed.push(address);
    }
    for (const address of want) {
      if (this.bound.has(address)) continue;
      try {
        this.bound.set(address, await this.bind(address));
        result.added.push(address);
      } catch (err) {
        result.failed.push({ address, error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const address of result.removed) log(`${this.label} stopped on ${address} (address gone)`);
    for (const f of result.failed) logError(`${this.label} bind ${f.address} failed (retrying next scan): ${f.error}`);
    if (this.bound.size === 0) logError(`${this.label}: not listening on ANY address`);
    return result;
  }

  /** Initial sync, then re-scan every `intervalMs`. */
  async start(intervalMs: number): Promise<SyncResult> {
    const first = await this.sync();
    this.timer = setInterval(() => void this.sync(), intervalMs);
    return first;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const listener of this.bound.values()) {
      try {
        listener.close();
      } catch {
        // ignore
      }
    }
    this.bound.clear();
  }
}
