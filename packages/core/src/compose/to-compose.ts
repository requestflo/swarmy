import type { ServiceModelOut } from './model';

/**
 * canonical ServiceModel[] -> a plain compose object (compose-spec shape). PURE
 * — the caller stringifies to YAML (the controller has the `yaml` lib). Emits
 * canonical long-form encodings; semantically equivalent to the import, not
 * necessarily byte-identical. `unsupported` keys are re-emitted verbatim so
 * import -> export is key-level faithful.
 */

export interface ComposeServiceOut {
  image?: string;
  command?: string[];
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  ports?: Array<{ target: number; published?: number; protocol: string; mode: string }>;
  volumes?: Array<{ type: string; source?: string; target: string; read_only?: boolean }>;
  networks?: string[];
  deploy?: ComposeDeployOut;
  [key: string]: unknown;
}

interface ComposeDeployOut {
  mode?: string;
  replicas?: number;
  restart_policy?: { condition?: string; max_attempts?: number };
  placement?: {
    constraints?: string[];
    preferences?: Array<Record<string, string>>;
    max_replicas_per_node?: number;
  };
}

export interface ComposeFileOut {
  services: Record<string, ComposeServiceOut>;
  [key: string]: unknown;
}

function buildDeploy(model: ServiceModelOut): ComposeDeployOut | undefined {
  const deploy: ComposeDeployOut = {};
  if (model.mode === 'global') {
    deploy.mode = 'global';
  } else {
    deploy.replicas = model.replicas;
  }
  if (model.restart && (model.restart.condition != null || model.restart.maxAttempts != null)) {
    deploy.restart_policy = {
      ...(model.restart.condition != null ? { condition: model.restart.condition } : {}),
      ...(model.restart.maxAttempts != null ? { max_attempts: model.restart.maxAttempts } : {}),
    };
  }
  if (model.placement) {
    const placement: NonNullable<ComposeDeployOut['placement']> = {};
    if (model.placement.constraints.length) placement.constraints = model.placement.constraints;
    if (model.placement.preferences.length) {
      placement.preferences = model.placement.preferences.map((p) => {
        const eq = p.indexOf('=');
        return eq === -1 ? { spread: p } : { [p.slice(0, eq)]: p.slice(eq + 1) };
      });
    }
    if (model.placement.maxReplicasPerNode != null) {
      placement.max_replicas_per_node = model.placement.maxReplicasPerNode;
    }
    if (Object.keys(placement).length) deploy.placement = placement;
  }
  return Object.keys(deploy).length ? deploy : undefined;
}

export function modelToComposeService(model: ServiceModelOut): ComposeServiceOut {
  const out: ComposeServiceOut = {};
  // Preserved unsupported keys first, so mapped fields win on collision.
  for (const [k, v] of Object.entries(model.unsupported)) out[k] = v;

  if (model.image) out.image = model.image;
  if (model.command.length) out.command = model.command;
  if (Object.keys(model.env).length) out.environment = model.env;
  if (Object.keys(model.labels).length) out.labels = model.labels;
  if (model.ports.length) {
    out.ports = model.ports.map((p) => ({
      target: p.target,
      ...(p.published != null ? { published: p.published } : {}),
      protocol: p.protocol,
      mode: p.mode,
    }));
  }
  if (model.mounts.length) {
    out.volumes = model.mounts.map((m) => ({
      type: m.type,
      ...(m.source != null ? { source: m.source } : {}),
      target: m.target,
      ...(m.readOnly ? { read_only: true } : {}),
    }));
  }
  if (model.networks.length) out.networks = model.networks;
  const deploy = buildDeploy(model);
  if (deploy) out.deploy = deploy;
  return out;
}

export function modelsToCompose(models: ServiceModelOut[]): ComposeFileOut {
  const services: Record<string, ComposeServiceOut> = {};
  for (const m of models) services[m.name] = modelToComposeService(m);
  return { services };
}
