import { z } from 'zod';

// Wire/render types are owned by @swarmy/core so the agent and the controller
// share one definition. The ingress package re-exports them.
export {
  RenderedConfig,
  RenderedFile,
  ServiceLabels,
  IngressStatus,
  IngressDriverName,
} from '@swarmy/core/protocol';
export type {
  RenderedConfig as RenderedConfigT,
  RenderedFile as RenderedFileT,
  ServiceLabels as ServiceLabelsT,
  IngressStatus as IngressStatusT,
} from '@swarmy/core/protocol';

import type { RenderedConfig, IngressStatus } from '@swarmy/core/protocol';

// ── Org-scoped config (persisted, controller-side) ─────────────────────

export const DomainRouteSchema = z.object({
  domain: z.string().min(1),
  pathPrefix: z.string().default('/'),
  service: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['auto', 'off', 'custom']).default('auto'),
  stripPathPrefix: z.boolean().default(false),
  middlewares: z.array(z.string()).default([]),
});
export type DomainRoute = z.infer<typeof DomainRouteSchema>;

export const IngressGlobalOptionsSchema = z.object({
  email: z.string().email().optional(),
  onDemandTls: z.boolean().default(false),
  defaultTls: z.enum(['auto', 'off']).default('auto'),
  network: z.string().default('swarmy'),
  /** Raw escape hatch (driver-typed): applyVia, provider, certs, etc. */
  extraConfig: z.record(z.unknown()).default({}),
});
export type IngressGlobalOptions = z.infer<typeof IngressGlobalOptionsSchema>;

export const IngressConfigSchema = z.object({
  driver: z.string().min(1),
  enabled: z.boolean().default(true),
  orgId: z.string(),
  targetNodes: z.array(z.string()).default([]),
  domains: z.array(DomainRouteSchema).default([]),
  globalOptions: IngressGlobalOptionsSchema.default({}),
});
export type IngressConfig = z.infer<typeof IngressConfigSchema>;

export type IngressValidationResult =
  | { ok: true }
  | { ok: false; errors: { path: string; message: string }[] };

export interface IngressStatusReportLite {
  nodeId: string;
  ok: boolean;
  message?: string;
}

/**
 * How a driver pushes work to node agent(s) and queries them. Implemented by
 * the controller (apps/api) over the agent WebSocket gateway. Driver code is
 * transport-agnostic — it only calls these.
 */
export interface DriverDispatch {
  sendToNode(nodeId: string, rendered: RenderedConfig): Promise<IngressStatusReportLite>;
  resolveTargetNodes(orgId: string, explicit: string[]): Promise<string[]>;
  queryStatus(nodeId: string, driver: string): Promise<IngressStatus>;
}

export interface IngressDriver {
  readonly name: string;
  validate(config: IngressConfig): IngressValidationResult;
  /** Pure, no IO. */
  render(config: IngressConfig): RenderedConfig;
  apply(
    rendered: RenderedConfig,
    dispatch: DriverDispatch,
    config: IngressConfig,
  ): Promise<IngressStatus>;
  status(config: IngressConfig, dispatch: DriverDispatch): Promise<IngressStatus>;
}
