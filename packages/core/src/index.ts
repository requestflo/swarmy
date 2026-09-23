/**
 * `@swarmy/core` root — shared types, view shapes, and input schemas.
 * The wire protocol is at `@swarmy/core/protocol`; the dockerode wrapper at
 * `@swarmy/core/docker`.
 */
export * from './types';
export * from './views';
export * from './inputs';
export * from './inventory';
export * from './controller-url';
export * from './manageddb-storage';
export * from './data-pin';
// NOTE: './crypto' (node:crypto credential vault) is server-only and is NOT
// re-exported here — import it via '@swarmy/core/crypto' so it never reaches the
// browser bundle.
