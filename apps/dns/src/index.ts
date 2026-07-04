import { loadConfig, log, logError } from './config';
import { SnapshotStore } from './store';
import { GeoIpManager } from './geoip-manager';
import { createMetrics } from './metrics';
import { startUdpServer } from './server-udp';
import { startTcpServer } from './server-tcp';
import { startAdminServer } from './admin';
import type { QueryContext } from './query';

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

  const udp = await startUdpServer(ctx, config.host, config.port);
  const tcp = startTcpServer(ctx, config.host, config.port);
  const admin = startAdminServer(config, store, metrics, geoip);

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
