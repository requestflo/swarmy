import { z } from 'zod';
import { CommandId } from './primitives';
import { ServiceSpec } from './commands';

/** Wire-level driver name. Mirrors the DB `IngressDriver` enum (lowercased). */
export const IngressDriverName = z.enum(['caddy', 'none', 'cloudflared']);
export type IngressDriverName = z.infer<typeof IngressDriverName>;

/** A config file the agent should write on the node. */
export const RenderedFile = z.object({
  path: z.string(),
  contents: z.string(),
  /** POSIX mode, e.g. 0o644 — agent applies it when writing. */
  mode: z.number().int().default(0o644),
});
export type RenderedFile = z.infer<typeof RenderedFile>;

/** Docker labels a driver wants set on a swarm service (e.g. Traefik). */
export const ServiceLabels = z.object({
  service: z.string(),
  labels: z.record(z.string()),
  /** Previously-managed label keys to delete (drift cleanup). */
  removeLabelKeys: z.array(z.string()).default([]),
});
export type ServiceLabels = z.infer<typeof ServiceLabels>;

/**
 * The full output of an ingress driver's `render()`. Produced by
 * `@swarmy/ingress`, carried verbatim to the agent inside `applyIngress`.
 * The agent writes `files`, sets `serviceLabels`, then runs `reloadCommand`
 * OR calls `adminApi` (whichever the driver provided).
 */
export const RenderedConfig = z.object({
  driver: z.string(),
  files: z.array(RenderedFile).default([]),
  reloadCommand: z.array(z.string()).optional(),
  adminApi: z
    .object({
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string(),
      body: z.string().optional(),
      contentType: z.string().default('application/json'),
    })
    .optional(),
  serviceLabels: z.array(ServiceLabels).default([]),
  /**
   * In-task reload: the agent finds THIS NODE's task of `service` via its
   * Docker socket (label com.docker.swarm.service.name), writes `file` inside
   * it (when set) and execs `command` there — per-node config without ever
   * publishing the admin API or touching the host FS. Used by the Caddy
   * driver for `applyVia: 'exec'` (replicated controller) and `'local'`
   * (edge-per-node: every edge node gets its own region-aware render).
   */
  localReload: z
    .object({
      service: z.string(),
      command: z.array(z.string()),
      /**
       * Write this file INSIDE the task (not on the host) before running
       * `command`. The agent on the node hosting the task delivers the config
       * over the docker socket — no overlay membership, no published admin
       * API, no host bind mount (works for systemd AND container agents).
       */
      file: z.object({ path: z.string(), contents: z.string() }).optional(),
    })
    .optional(),
  /**
   * Tunnel/connector deployment (cloudflared, tailscale, ngrok). When present the
   * agent deploys/updates this Swarm service (via `deployOrUpdate`) instead of —
   * or in addition to — writing vhost files. Absent for Caddy/Traefik/nginx/
   * haproxy so those flows are byte-for-byte unchanged. Secrets are referenced,
   * never inlined: the controller resolves `secrets[].value` just-in-time before
   * dispatch and the agent injects them as the service's env.
   */
  connector: z
    .object({
      kind: z.enum(['cloudflared', 'tailscale', 'ngrok']),
      /** Reuse the existing ServiceSpec — the agent already deploys these. */
      service: ServiceSpec,
      /**
       * Secret refs resolved just-in-time. `ref` is the vault pointer (for audit/
       * preview); `value` is the decrypted secret, present only on the dispatched
       * render (never persisted, never returned to clients).
       */
      secrets: z
        .array(
          z.object({
            name: z.string(),
            ref: z.string(),
            value: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
  /** Human-inspectable summary for the previewConfig UI. */
  summary: z.string().default(''),
});
export type RenderedConfig = z.infer<typeof RenderedConfig>;

export const IngressCertInfo = z.object({
  domain: z.string(),
  issuer: z.string().optional(),
  notAfter: z.string().optional(),
  valid: z.boolean(),
});
export type IngressCertInfo = z.infer<typeof IngressCertInfo>;

export const IngressStatus = z.object({
  driver: z.string(),
  healthy: z.boolean(),
  version: z.string().optional(),
  activeDomains: z.array(z.string()).default([]),
  certs: z.array(IngressCertInfo).default([]),
  lastAppliedAt: z.string().optional(),
  message: z.string().optional(),
});
export type IngressStatus = z.infer<typeof IngressStatus>;

export const ApplyIngressPayload = z.object({
  commandId: CommandId,
  timeoutMs: z.number().int().positive().optional(),
  rendered: RenderedConfig,
});
export type ApplyIngressPayload = z.infer<typeof ApplyIngressPayload>;

export const ApplyIngressMsg = z.object({
  type: z.literal('applyIngress'),
  payload: ApplyIngressPayload,
});
export type ApplyIngressMsg = z.infer<typeof ApplyIngressMsg>;


/**
 * Per-node edge health telemetry (geo-edge): sampled by the agent from its
 * LOCAL Docker state on a timer and pushed like `meshState`. The controller
 * folds this into DNS answer healthiness — a node whose Caddy task is gone
 * must leave the answer set even while the agent itself is online.
 */
export const IngressNodeStatusPayload = z.object({
  /** A running local task of the edge Caddy service exists on this node. */
  caddyRunning: z.boolean(),
  /** A running local task of swarmy-dns exists on this node. */
  dnsRunning: z.boolean(),
  sampledAt: z.number().int(),
});
export type IngressNodeStatusPayload = z.infer<typeof IngressNodeStatusPayload>;

export const IngressNodeStatusMsg = z.object({
  type: z.literal('ingressNodeStatus'),
  payload: IngressNodeStatusPayload,
});
export type IngressNodeStatusMsg = z.infer<typeof IngressNodeStatusMsg>;
