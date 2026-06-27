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

  return spec;
}
