/**
 * `@swarmy/core` root — shared types, view shapes, and input schemas.
 * The wire protocol is at `@swarmy/core/protocol`; the dockerode wrapper at
 * `@swarmy/core/docker`.
 */
export * from './types';
export * from './views';
export * from './inputs';
export * from './inventory';
export * from './network-policy';
export * from './overlay-mtu-check';
export * from './controller-url';
export * from './public-ip';
export * from './manageddb-pg';
export * from './manageddb-storage';
export * from './manageddb-placement';
export * from './manageddb-failover';
export * from './manageddb-extensions';
export * from './manageddb-extensions-plan';
export * from './data-pin';
export * from './db-restore-copy';
export * from './disk-forecast';
export * from './disk-inventory';
export * from './volume-move';
export * from './dotenv';
export * from './secret-args';
export * from './pull-errors';
export * from './swarm-kv';
export * from './swarm-kv-size';
export * from './app-secrets';
export * from './service-inspect';
export * from './healthcheck';
export * from './container-health';
export * from './clickhouse';
export * from './telemetry';
export * from './container-logs';
export * from './api-keys';
export * from './alert-targets';
export * from './alert-quiet-hours';
export * from './alert-render';
export * from './alert-render-apps';
export * from './cost-budget';
export * from './doh-resolvers';
export * from './prometheus-text';
export * from './edge-traffic';
export * from './edge-traffic-hosts';
export * from './edge-traffic-caddy';
export * from './edge-traffic-extras';
export * from './edge-latency';
export * from './node-stats-history';
export * from './data-history';
export * from './queue-autoscale';
export * from './image-ref';
export * from './bucket-cors';
export * from './bucket-lifecycle';
export * from './admission-record';
export * from './admission-tally';
export * from './search-indexes';
export * from './search-synonyms';
// NOTE: './crypto' (node:crypto credential vault) is server-only and is NOT
// re-exported here — import it via '@swarmy/core/crypto' so it never reaches the
// browser bundle.
