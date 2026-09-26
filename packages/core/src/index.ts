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
export * from './controller-url';
export * from './public-ip';
export * from './manageddb-pg';
export * from './manageddb-storage';
export * from './manageddb-failover';
export * from './data-pin';
export * from './disk-forecast';
export * from './disk-inventory';
export * from './volume-move';
export * from './dotenv';
export * from './pull-errors';
export * from './swarm-kv';
export * from './app-secrets';
export * from './clickhouse';
export * from './telemetry';
// NOTE: './crypto' (node:crypto credential vault) is server-only and is NOT
// re-exported here — import it via '@swarmy/core/crypto' so it never reaches the
// browser bundle.
