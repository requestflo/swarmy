import { INGRESS_DRIVER_LABELS } from '@swarmy/core';

export type IngressDriverId = 'none' | 'caddy' | 'traefik' | 'cloudflared' | 'nginx' | 'haproxy';

export const ALL_DRIVERS: IngressDriverId[] = [
  'none',
  'caddy',
  'traefik',
  'cloudflared',
  'nginx',
  'haproxy',
];

/**
 * Local label map so the UI compiles before the integrator widens
 * `INGRESS_DRIVER_LABELS` in @swarmy/core (see INTEGRATION). Falls back to the
 * shared map for the existing three drivers.
 */
export const DRIVER_LABELS: Record<IngressDriverId, string> = {
  none: INGRESS_DRIVER_LABELS.none,
  caddy: INGRESS_DRIVER_LABELS.caddy,
  traefik: INGRESS_DRIVER_LABELS.traefik,
  cloudflared: 'Cloudflare Tunnel',
  nginx: 'nginx',
  haproxy: 'HAProxy',
};

export const DRIVER_BLURB: Record<IngressDriverId, string> = {
  none: 'Unopinionated by default. Bring your own proxy — swarmy stays out of the way.',
  caddy: 'Automatic HTTPS. Recommended. Needs a public IP and a domain.',
  traefik: 'Advanced / bring-your-own. Label-based routing for existing Traefik users.',
  cloudflared: 'No public IP needed — connect via Cloudflare. Needs a Cloudflare account.',
  nginx: 'Classic reverse proxy. Pairs with an external ACME companion for TLS.',
  haproxy: 'High-throughput L7 proxy. SNI routing; external cert management.',
};
