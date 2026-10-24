/**
 * The "didn't translate" half of Convert to swarmy.yaml: what a compose
 * service says that swarmy.yaml has no home for, each with why and what to do
 * instead. Pure; {@link composeToAppConfig} asks it per service.
 */
import { portsOf, volumesOf, type ComposeService, type VolumeEntry } from './from-compose-read';

export interface ComposeGap {
  /** The compose service it came from. */
  service: string;
  /** The compose key, as written: `privileged`, `volumes: ./data:/data`, `environment.API_TOKEN`. */
  key: string;
  /** Why it isn't in the file, and what to do instead. */
  reason: string;
  /** swarmy does this itself, so nothing is lost (`depends_on`, `restart`, …). */
  handled?: true;
}

export const gapSentence = (g: ComposeGap): string => `${g.service}: ${g.key} isn't carried over — ${g.reason}.`;

const WIRED = 'swarmy wires services and resources together itself';
const CAPS = 'swarmy.yaml has no Linux capabilities setting';
const STOP = 'swarmy.yaml has no stop settings';

/** Service keys swarmy.yaml has no home for. */
const NO_HOME: Record<string, string> = {
  privileged: "swarm services can't run privileged, and swarmy.yaml has no way to ask for it",
  cap_add: CAPS,
  cap_drop: CAPS,
  devices: "a device on the server ties the app to that one server; swarmy.yaml can't pass it through",
  network_mode: "every service joins its app's private network; host networking isn't available",
  pid: "sharing the server's processes isn't available to swarmy services",
  ipc: "sharing the server's IPC namespace isn't available to swarmy services",
  userns_mode: 'swarmy.yaml has no user-namespace setting',
  security_opt: 'swarmy.yaml has no security options',
  sysctls: 'swarmy.yaml has no kernel settings',
  ulimits: 'swarmy.yaml has no ulimits; set them in the image',
  user: "swarmy runs the image's own user; set USER in the Dockerfile",
  entrypoint: 'swarmy.yaml sets command:, not the entrypoint; set ENTRYPOINT in the image',
  working_dir: 'set WORKDIR in the image',
  extra_hosts: 'swarmy.yaml has no hosts-file entries; services reach each other by name',
  dns: "services use the swarm's own DNS",
  tmpfs: 'swarmy.yaml has no tmpfs mounts',
  shm_size: 'swarmy.yaml has no shared-memory size',
  read_only: 'swarmy.yaml has no read-only root filesystem setting',
  init: 'swarmy.yaml has no init setting; add tini to the image if you need one',
  stop_grace_period: STOP,
  stop_signal: STOP,
  env_file: "swarmy doesn't read env files; put the values under env:, and credentials in swarmy secrets",
  healthcheck: 'write it as healthcheck: with a path: or a command:',
  labels: 'swarmy sets its own labels; addresses go under domains:',
  secrets: 'create each one as a swarmy secret, then list it under secrets:',
  configs: 'swarmy.yaml has no configs; bake the file into the image, or use env',
  mem_limit: 'set memory: (or size:) instead',
  cpus: 'set cpu: (or size:) instead',
};

/** Keys swarmy covers itself: listed, but nothing is lost. */
const HANDLED: Record<string, string> = {
  depends_on: WIRED,
  links: WIRED,
  networks: WIRED,
  restart: 'swarmy restarts a service that stops',
  logging: "swarmy collects every service's logs itself",
  container_name: 'swarm names containers itself',
  hostname: 'services reach each other by service name',
};

const DEPLOY_NO_HOME: Record<string, string> = {
  mode: 'swarmy.yaml runs a set number of copies, not one per server; set replicas:',
  placement: 'pin it with regions: or placement.labels instead',
  resources: 'set cpu: and memory: (or size:) instead',
  endpoint_mode: 'swarmy.yaml has no endpoint mode',
};
const DEPLOY_HANDLED: Record<string, string> = {
  update_config: 'swarmy rolls out with its own health gate',
  rollback_config: 'swarmy puts back the last good release itself',
  restart_policy: 'swarmy restarts a service that stops',
  labels: 'swarmy sets its own labels',
};

const set = (v: unknown): boolean => v !== undefined && v !== null && v !== false;

/** Keys and `deploy:` settings swarmy.yaml has no home for. */
export function keyGaps(service: string, svc: ComposeService): ComposeGap[] {
  const deploy = svc.deploy && typeof svc.deploy === 'object' ? (svc.deploy as Record<string, unknown>) : {};
  const out: ComposeGap[] = [];
  const add = (key: string, reason: string, handled: boolean): void => {
    out.push({ service, key, reason, ...(handled ? { handled: true as const } : {}) });
  };
  for (const [k, reason] of Object.entries(NO_HOME)) if (set(svc[k])) add(k, reason, false);
  for (const [k, reason] of Object.entries(DEPLOY_NO_HOME)) {
    if (set(deploy[k]) && (k !== 'mode' || deploy.mode === 'global')) add(`deploy.${k}`, reason, false);
  }
  for (const [k, reason] of Object.entries(HANDLED)) if (set(svc[k])) add(k, reason, true);
  for (const [k, reason] of Object.entries(DEPLOY_HANDLED)) if (set(deploy[k])) add(`deploy.${k}`, reason, true);
  return out;
}

/** Ports beyond the one swarmy.yaml keeps, and host ports swarmy replaces with an address. */
export function portGaps(service: string, svc: ComposeService, kept: number | undefined): ComposeGap[] {
  return portsOf(svc.ports).flatMap((p): ComposeGap[] => {
    const key = `ports: ${p.raw}`;
    if (p.target !== kept) return [{ service, key, reason: `a service has one port: in swarmy.yaml, and this one keeps ${kept}` }];
    if (!p.published) return [];
    return [{ service, key, reason: `port ${p.published} isn't opened on every server any more: the app's own services still reach it, and the web gets an address under domains:` }];
  });
}

/** A volume entry that can't become a named swarmy volume (null when it can). */
export function volumeGap(service: string, v: VolumeEntry): ComposeGap | null {
  const key = `volumes: ${v.raw}`;
  if (v.source === '/var/run/docker.sock') return { service, key, reason: "swarmy doesn't hand services the Docker socket" };
  if (v.bind) return { service, key, reason: 'a folder on one server, and swarmy uses named volumes so the app can move between servers: copy what it needs into the image or a volume' };
  if (!v.source) return { service, key, reason: 'an unnamed volume; give it a name under volumes: if it holds data worth keeping' };
  return null;
}

/** What's lost when a data service becomes a managed resource. */
export function resourceGaps(service: string, svc: ComposeService, kind: string, name: string): ComposeGap[] {
  const out: ComposeGap[] = volumesOf(svc.volumes).map((v) => ({
    service,
    key: `volumes: ${v.raw}`,
    reason: `the data in it doesn't move: the managed ${kind} "${name}" starts empty, so restore a dump into it after the first deploy`,
  }));
  if (svc.environment !== undefined) out.push({ service, key: 'environment', reason: `swarmy sets up the managed ${kind} with its own credentials and hands them to your services through bindings` });
  if (svc.command !== undefined) out.push({ service, key: 'command', reason: `swarmy runs the managed ${kind} with its own settings` });
  if (portsOf(svc.ports).some((p) => p.published)) out.push({ service, key: 'ports', reason: `the managed ${kind} stays on the app's private network` });
  return out;
}
