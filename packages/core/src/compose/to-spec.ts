import type { ServiceModelOut } from './model';

/**
 * canonical ServiceModel -> the wire `ServiceSpec` the agent applies. PURE.
 *
 * We intentionally do NOT import the protocol `ServiceSpec` Zod here to keep
 * this subpath free of the protocol module; the returned object is structurally
 * compatible with `@swarmy/core/protocol`'s `ServiceSpec` (including the
 * additive `placement` field — see the INTEGRATION snippet in the epic).
 */

export interface ServiceSpecPlacement {
  constraints?: string[];
  preferences?: string[];
  maxReplicasPerNode?: number;
}

export interface ServiceSpecHealthcheck {
  test?: string[];
  intervalNs?: number;
  timeoutNs?: number;
  startPeriodNs?: number;
  retries?: number;
  disable?: boolean;
}

export interface ServiceSpecResourceBucket {
  cpus?: number;
  memoryBytes?: number;
}

export interface ServiceSpecResources {
  limits?: ServiceSpecResourceBucket;
  reservations?: ServiceSpecResourceBucket;
}

export interface ServiceSpecConfigSecretRef {
  source: string;
  target?: string;
  uid?: string;
  gid?: string;
  mode?: number;
}

export interface ServiceSpecLike {
  name: string;
  image: string;
  mode?: { replicated?: { replicas: number }; global?: Record<string, never> };
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  labels?: Record<string, string>;
  ports?: Array<{
    target: number;
    published?: number;
    protocol: 'tcp' | 'udp';
    mode: 'ingress' | 'host';
  }>;
  mounts?: Array<{
    type: 'volume' | 'bind' | 'tmpfs';
    source?: string;
    target: string;
    readOnly?: boolean;
  }>;
  networks?: string[];
  restartPolicy?: { condition?: 'none' | 'on-failure' | 'any'; maxAttempts?: number };
  placement?: ServiceSpecPlacement;
  healthcheck?: ServiceSpecHealthcheck;
  resources?: ServiceSpecResources;
  configs?: ServiceSpecConfigSecretRef[];
  secrets?: ServiceSpecConfigSecretRef[];
  stopGracePeriodNs?: number;
}

export function modelToServiceSpec(model: ServiceModelOut): ServiceSpecLike {
  const spec: ServiceSpecLike = {
    name: model.name,
    image: model.image,
    mode:
      model.mode === 'global'
        ? { global: {} }
        : { replicated: { replicas: model.replicas } },
  };

  if (Object.keys(model.env).length) spec.env = model.env;
  if (model.command.length) spec.command = model.command;
  if (model.args.length) spec.args = model.args;
  if (Object.keys(model.labels).length) spec.labels = model.labels;
  if (model.ports.length) spec.ports = model.ports;
  if (model.mounts.length) {
    spec.mounts = model.mounts.map((m) => ({
      type: m.type,
      ...(m.source != null ? { source: m.source } : {}),
      target: m.target,
      readOnly: m.readOnly,
    }));
  }
  if (model.networks.length) spec.networks = model.networks;
  if (model.restart && (model.restart.condition != null || model.restart.maxAttempts != null)) {
    spec.restartPolicy = {
      ...(model.restart.condition != null ? { condition: model.restart.condition } : {}),
      ...(model.restart.maxAttempts != null ? { maxAttempts: model.restart.maxAttempts } : {}),
    };
  }
  if (model.placement) {
    const placement: ServiceSpecPlacement = {};
    if (model.placement.constraints.length) placement.constraints = model.placement.constraints;
    if (model.placement.preferences.length) placement.preferences = model.placement.preferences;
    if (model.placement.maxReplicasPerNode != null) {
      placement.maxReplicasPerNode = model.placement.maxReplicasPerNode;
    }
    if (Object.keys(placement).length) spec.placement = placement;
  }

  if (model.healthcheck) {
    const hc = model.healthcheck;
    const out: ServiceSpecHealthcheck = {};
    if (hc.test.length) out.test = hc.test;
    if (hc.intervalNs != null) out.intervalNs = hc.intervalNs;
    if (hc.timeoutNs != null) out.timeoutNs = hc.timeoutNs;
    if (hc.startPeriodNs != null) out.startPeriodNs = hc.startPeriodNs;
    if (hc.retries != null) out.retries = hc.retries;
    if (hc.disable) out.disable = true;
    if (Object.keys(out).length) spec.healthcheck = out;
  }

  if (model.resources) {
    const bucket = (b?: { cpus?: number; memoryBytes?: number }): ServiceSpecResourceBucket | undefined => {
      if (!b) return undefined;
      const o: ServiceSpecResourceBucket = {};
      if (b.cpus != null) o.cpus = b.cpus;
      if (b.memoryBytes != null) o.memoryBytes = b.memoryBytes;
      return Object.keys(o).length ? o : undefined;
    };
    const limits = bucket(model.resources.limits);
    const reservations = bucket(model.resources.reservations);
    if (limits || reservations) {
      spec.resources = {
        ...(limits ? { limits } : {}),
        ...(reservations ? { reservations } : {}),
      };
    }
  }

  const cleanRef = (c: {
    source: string;
    target?: string;
    uid?: string;
    gid?: string;
    mode?: number;
  }): ServiceSpecConfigSecretRef => ({
    source: c.source,
    ...(c.target != null ? { target: c.target } : {}),
    ...(c.uid != null ? { uid: c.uid } : {}),
    ...(c.gid != null ? { gid: c.gid } : {}),
    ...(c.mode != null ? { mode: c.mode } : {}),
  });
  if (model.configs.length) spec.configs = model.configs.map(cleanRef);
  if (model.secrets.length) spec.secrets = model.secrets.map(cleanRef);
  if (model.stopGracePeriodNs != null) spec.stopGracePeriodNs = model.stopGracePeriodNs;

  return spec;
}
