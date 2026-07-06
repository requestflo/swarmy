/**
 * Non-Zod shared constants/labels used across the UI and services.
 * (Wire enums live in `@swarmy/core/protocol`.)
 */
import type { ExposureOverview, ExposureRowView } from './views';

export const INGRESS_DRIVERS = ['caddy', 'traefik', 'none', 'cloudflared', 'nginx', 'haproxy'] as const;
export type IngressDriverId = (typeof INGRESS_DRIVERS)[number];

export const INGRESS_DRIVER_LABELS: Record<IngressDriverId, string> = {
  caddy: 'Caddy',
  traefik: 'Traefik',
  none: 'None (self-managed)',
  cloudflared: 'Cloudflare Tunnel',
  nginx: 'nginx',
  haproxy: 'HAProxy',
};

export const NODE_STATUS_TONE: Record<string, 'online' | 'warning' | 'offline' | 'neutral'> = {
  online: 'online',
  draining: 'warning',
  degraded: 'warning',
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

// ── Declared exposure intent (WS3) — the `swarmy.expose` service label ────────

/**
 * Service label carrying the DECLARED exposure intent (Docker truth, no DB row).
 * The inferred classifier verdict stays the *observed* half of the comparison;
 * this label is the *chosen* half. Absent label = undeclared (audit-only).
 */
export const EXPOSE_LABEL = 'swarmy.expose';

export const EXPOSE_MODES = ['public', 'tunnel', 'private', 'mesh'] as const;
/** Declared exposure intent: chosen in the UI, enforced at admission, drift-audited. */
export type ExposeMode = (typeof EXPOSE_MODES)[number];

/** Display names for the mode selector. */
export const EXPOSE_MODE_LABELS: Record<ExposeMode, string> = {
  public: 'Public',
  tunnel: 'Tunnel',
  private: 'Private',
  mesh: 'Mesh-only',
};

/** Parse a raw `swarmy.expose` label value; unknown/absent → null (undeclared). */
export function parseExposeMode(raw: string | null | undefined): ExposeMode | null {
  return raw != null && (EXPOSE_MODES as readonly string[]).includes(raw)
    ? (raw as ExposeMode)
    : null;
}

/** `violation` = declared intent is contradicted; `warning` = declared but unrealised. */
export type ExposureDriftLevel = 'violation' | 'warning';

/** Declared ≠ observed for one service: how bad, and why in plain words. */
export interface ExposureDriftView {
  level: ExposureDriftLevel;
  message: string;
}

/** An audit row plus the declared half of the comparison. */
export interface ExposureIntentRowView extends ExposureRowView {
  /** The `swarmy.expose` label value, or null when undeclared. */
  declared: ExposeMode | null;
  /** Non-null when declared ≠ observed. */
  drift: ExposureDriftView | null;
}

/** `ExposureOverview` whose rows carry declared intent + drift. */
export interface ExposureIntentOverview {
  rows: ExposureIntentRowView[];
  counts: ExposureOverview['counts'];
  auditedAt: string;
}
