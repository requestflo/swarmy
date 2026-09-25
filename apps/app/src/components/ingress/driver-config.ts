import { INGRESS_DRIVER_LABELS } from '@swarmy/core';

export type IngressDriverId = 'none' | 'caddy' | 'cloudflared';

export const ALL_DRIVERS: IngressDriverId[] = ['none', 'caddy', 'cloudflared'];

/**
 * Local label map so the UI compiles before the integrator widens
 * `INGRESS_DRIVER_LABELS` in @swarmy/core (see INTEGRATION). Falls back to the
 * shared map for the existing three drivers.
 */
export const DRIVER_LABELS: Record<IngressDriverId, string> = {
  none: INGRESS_DRIVER_LABELS.none,
  caddy: INGRESS_DRIVER_LABELS.caddy,
  cloudflared: INGRESS_DRIVER_LABELS.cloudflared,
};

export const DRIVER_BLURB: Record<IngressDriverId, string> = {
  none: 'Unopinionated by default. Bring your own proxy — swarmy stays out of the way.',
  caddy: 'Automatic HTTPS. Recommended. Needs a public IP and a domain.',
  cloudflared: 'No public IP needed — connect via Cloudflare. Needs a Cloudflare account.',
};
