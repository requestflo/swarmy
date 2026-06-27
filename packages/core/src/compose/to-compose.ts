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
  healthcheck?: ComposeHealthcheckOut;
  configs?: ComposeConfigSecretOut[];
  secrets?: ComposeConfigSecretOut[];
  ulimits?: Record<string, { soft?: number; hard?: number }>;
  logging?: { driver?: string; options?: Record<string, string> };
  depends_on?: string[];
  stop_grace_period?: string;
  deploy?: ComposeDeployOut;
  [key: string]: unknown;
}

interface ComposeHealthcheckOut {
  test?: string[];
  interval?: string;
  timeout?: string;
  start_period?: string;
  retries?: number;
  disable?: boolean;
}

interface ComposeConfigSecretOut {
  source: string;
  target?: string;
  uid?: string;
  gid?: string;
  mode?: number;
}

interface ComposeDeployOut {
  mode?: string;
  replicas?: number;
  restart_policy?: { condition?: string; max_attempts?: number };
  resources?: {
    limits?: { cpus?: number; memory?: number };
    reservations?: { cpus?: number; memory?: number };
  };
  placement?: {
    constraints?: string[];
    preferences?: Array<Record<string, string>>;
    max_replicas_per_node?: number;
  };
}

/** ns -> a canonical compose duration string our parser round-trips exactly. */
function nsToDuration(ns: number): string {
  return `${ns}ns`;
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
  if (model.resources) {
    const bucket = (b?: { cpus?: number; memoryBytes?: number }): { cpus?: number; memory?: number } | undefined => {
      if (!b) return undefined;
      const o: { cpus?: number; memory?: number } = {};
      if (b.cpus != null) o.cpus = b.cpus;
      if (b.memoryBytes != null) o.memory = b.memoryBytes;
      return Object.keys(o).length ? o : undefined;
    };
    const limits = bucket(model.resources.limits);
    const reservations = bucket(model.resources.reservations);
    if (limits || reservations) {
      deploy.resources = {
        ...(limits ? { limits } : {}),
        ...(reservations ? { reservations } : {}),
      };
    }
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

  if (model.healthcheck) {
    const hc = model.healthcheck;
    const o: ComposeHealthcheckOut = {};
    if (hc.test.length) o.test = hc.test;
    if (hc.intervalNs != null) o.interval = nsToDuration(hc.intervalNs);
    if (hc.timeoutNs != null) o.timeout = nsToDuration(hc.timeoutNs);
    if (hc.startPeriodNs != null) o.start_period = nsToDuration(hc.startPeriodNs);
    if (hc.retries != null) o.retries = hc.retries;
    if (hc.disable) o.disable = true;
    if (Object.keys(o).length) out.healthcheck = o;
  }
  if (model.configs.length) {
    out.configs = model.configs.map((c) => ({ ...c }));
  }
  if (model.secrets.length) {
    out.secrets = model.secrets.map((s) => ({ ...s }));
  }
  if (model.ulimits.length) {
    out.ulimits = {};
    for (const u of model.ulimits) {
      out.ulimits[u.name] = {
        ...(u.soft != null ? { soft: u.soft } : {}),
        ...(u.hard != null ? { hard: u.hard } : {}),
      };
    }
  }
  if (model.logging) {
    const lg: { driver?: string; options?: Record<string, string> } = {};
    if (model.logging.driver != null) lg.driver = model.logging.driver;
    if (Object.keys(model.logging.options).length) lg.options = model.logging.options;
    if (Object.keys(lg).length) out.logging = lg;
  }
  if (model.dependsOn.length) out.depends_on = model.dependsOn;
  if (model.stopGracePeriodNs != null) out.stop_grace_period = nsToDuration(model.stopGracePeriodNs);

  const deploy = buildDeploy(model);
  if (deploy) out.deploy = deploy;
  return out;
}

export function modelsToCompose(models: ServiceModelOut[]): ComposeFileOut {
  const services: Record<string, ComposeServiceOut> = {};
  for (const m of models) services[m.name] = modelToComposeService(m);
  return { services };
}
