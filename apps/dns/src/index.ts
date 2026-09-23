import { loadConfig, log, logError } from './config';
import { SnapshotStore } from './store';
import { GeoIpManager } from './geoip-manager';
import { createMetrics } from './metrics';
import { startUdpServer } from './server-udp';
import { startTcpServer } from './server-tcp';
import { startAdminServer } from './admin';
import type { QueryContext } from './query';
import {
  ListenerSet,
  hostInterfaces,
  selectAdminListenAddresses,
  selectDnsListenAddresses,
} from './listen';

/**
 * swarmy-dns — the authoritative geo-DNS server that makes every ingress+outlet
 * node a nameserver (docs/product/edge-network.md). Boot order matters:
 * snapshot first (answers immediately from last-good state), then geoip in the
 * background, then the listeners.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  if (!config.adminToken && !config.allowInsecureAdmin) {
    log('warning: no admin token configured — snapshot pushes will be rejected (set SWARMY_DNS_ALLOW_INSECURE_ADMIN=1 for local dev)');
  }

  const store = new SnapshotStore(config.dataDir);
  await store.load();

  const geoip = new GeoIpManager(config);
  await geoip.start();

  const metrics = createMetrics();
  const ctx: QueryContext = { store, metrics, geoip: () => geoip.current() };

  // Host networking, per-address binds (never 0.0.0.0 — systemd-resolved's
  // stub owns 127.0.0.53:53 on stock Ubuntu). Re-scanned for new addresses.
  const dnsAddrs = (): string[] => config.listen ?? selectDnsListenAddresses(hostInterfaces());
  const adminAddrs = (): string[] =>
    config.adminListen ?? selectAdminListenAddresses(hostInterfaces());
  const udp = new ListenerSet('udp', dnsAddrs, (host) => startUdpServer(ctx, host, config.port));
  const tcp = new ListenerSet('tcp', dnsAddrs, (host) => startTcpServer(ctx, host, config.port));
  const admin = new ListenerSet('admin', adminAddrs, (host) =>
    startAdminServer(config, store, metrics, geoip, host),
  );
  await Promise.all([
    udp.start(config.rescanMs),
    tcp.start(config.rescanMs),
    admin.start(config.rescanMs),
  ]);

  log(`serving ${store.current?.zones.length ?? 0} zones (bundle v${store.version})`);

  const shutdown = (signal: string) => {
    log(`${signal} — shutting down`);
    udp.close();
    tcp.close();
    admin.close();
    geoip.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logError('fatal:', err);
  process.exit(1);
});
