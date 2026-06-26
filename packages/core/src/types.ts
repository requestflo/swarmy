/**
 * Non-Zod shared constants/labels used across the UI and services.
 * (Wire enums live in `@swarmy/core/protocol`.)
 */

export const INGRESS_DRIVERS = ['caddy', 'traefik', 'none'] as const;
export type IngressDriverId = (typeof INGRESS_DRIVERS)[number];

export const INGRESS_DRIVER_LABELS: Record<IngressDriverId, string> = {
  caddy: 'Caddy',
  traefik: 'Traefik',
  none: 'None (self-managed)',
};

export const NODE_STATUS_TONE: Record<string, 'online' | 'warning' | 'offline' | 'neutral'> = {
  online: 'online',
  draining: 'warning',
  pending: 'neutral',
  offline: 'offline',
};

export const SERVICE_STATUS_TONE: Record<
  string,
  'online' | 'warning' | 'offline' | 'neutral' | 'progress'
> = {
  running: 'online',
  degraded: 'warning',
  deploying: 'progress',
  pending: 'neutral',
  stopped: 'neutral',
  removing: 'warning',
  failed: 'offline',
};

export const AGENT_VERSION = '0.1.0';

/** Token prefixes (see protocol §2). */
export const JOIN_TOKEN_PREFIX = 'swt';
export const SESSION_TOKEN_PREFIX = 'sst';
