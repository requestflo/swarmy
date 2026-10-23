/**
 * The fields the Connections tab reads off `stacks.endpoints`
 * (packages/trpc/src/services/service-endpoints.ts). Every name is what swarm
 * DNS answers right now, from live Docker truth.
 */
export type EndpointScope = 'app' | 'connected' | 'attached';

export interface EndpointName {
  host: string;
  port?: number;
  /** Who can resolve it: this app / a connected app / attached app services. */
  scope: EndpointScope;
  /** For `connected`: the peer apps. */
  from?: string[];
}

export interface ServiceEndpoints {
  /** Swarm service name (`storefront_web`). */
  service: string;
  /** Compose short name (`web`). */
  short: string;
  ports: number[];
  names: EndpointName[];
}

export type ResourceKind = 'postgres' | 'cache' | 'search' | 'vector' | 'object-storage';

export interface ResourceEndpoint {
  kind: ResourceKind;
  /** Cluster / instance / bucket name. */
  name: string;
  host: string;
  port: number;
  /** `primary` / `replica` / `sentinel`. */
  role?: string;
  /** App services of this app wired to it (they alone share its network). */
  attached: string[];
}

export interface StackEndpoints {
  stack: string;
  /** Apps this one is connected to. */
  connectedApps: string[];
  services: ServiceEndpoints[];
  resources: ResourceEndpoint[];
}

/** The audit fields the "who connected it" line reads (`audit.list`). */
export interface LinkAuditEntry {
  ts: string;
  actorLabel: string;
  action: string;
  targetId: string | null;
}
