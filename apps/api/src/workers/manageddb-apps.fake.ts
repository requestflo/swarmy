import { createHash } from 'node:crypto';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub } from '../gateway';

/**
 * TEST HELPER — a small stateful swarm installed onto the controller's own
 * hub (instance methods shadow the class's; `uninstall` puts them back), so
 * the manageddb reconcile's promotion pass and the @swarmy/trpc services it
 * calls run unchanged against it: services deployed / inspected / relabelled,
 * Docker secrets with the agent's content-hash semantics, and `exec` into a
 * running task (`cat` of a mounted secret, `pg_promote`, `pg_is_in_recovery`).
 */

type Ref = { source: string; target?: string };
interface Svc {
  spec: ServiceSpec;
  refs: Ref[];
  down: boolean;
  gen: number;
}

const HASH = 'swarmy.content.sha256';
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

export function fakeSwarm(orgId: string) {
  const services = new Map<string, Svc>();
  const secrets = new Map<string, { value: string; labels: Record<string, string> }>();
  const promoted = new Set<string>();
  const calls: Array<{ cmd: string; payload: any }> = [];
  /** Services whose next deploy fails (a controller that died mid-pass). */
  const failNextDeploy = new Set<string>();
  const replicas = (s: Svc) => s.spec.mode?.replicated?.replicas ?? 1;

  const info = (s: Svc): SwarmServiceInfo =>
    ({
      id: `id-${s.spec.name}`,
      name: s.spec.name,
      image: s.spec.image,
      mode: 'replicated',
      desiredReplicas: replicas(s),
      runningReplicas: s.down ? 0 : replicas(s),
      createdAt: 0,
      updatedAt: s.gen,
      labels: { ...(s.spec.labels ?? {}) },
      env: Object.entries(s.spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      networks: (s.spec.networks ?? []).map((n) => ({ name: n, aliases: [] })),
      ports: [],
      secrets: s.refs.map((r) => r.source),
      configs: [],
      mounts: [],
    }) as SwarmServiceInfo;
  const containers = () =>
    [...services.values()]
      .filter((s) => !s.down && replicas(s) > 0)
      .map((s) => ({ id: `c-${s.spec.name}-${s.gen}`, serviceId: `id-${s.spec.name}`, state: 'running', createdAt: s.gen, labels: {} }));
  const byContainer = (id: string) => [...services.values()].find((s) => `c-${s.spec.name}-${s.gen}` === id);

  /** Deploy (or seed) a service spec; a redeploy is a new task. */
  const put = (spec: ServiceSpec, o: { down?: boolean } = {}) => {
    const prev = services.get(spec.name);
    services.set(spec.name, { spec, refs: (spec.secrets ?? []).map((r) => ({ ...r })), down: o.down ?? false, gen: (prev?.gen ?? 0) + 1 });
  };
  const seedSecret = (name: string, value: string) => secrets.set(name, { value, labels: { [HASH]: sha(value) } });

  const dispatch = async (_node: string, cmd: string, payload: any): Promise<any> => {
    calls.push({ cmd, payload });
    const svc = services.get(payload?.service);
    switch (cmd) {
      case 'service.inspect': {
        const s = svc!;
        const ContainerSpec = {
          Image: s.spec.image,
          Env: Object.entries(s.spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
          Secrets: s.refs.map((r) => ({ SecretName: r.source, File: { Name: r.target ?? r.source } })),
        };
        return { inspect: { ID: `id-${s.spec.name}`, Spec: { Name: s.spec.name, Labels: s.spec.labels, Mode: { Replicated: { Replicas: replicas(s) } }, TaskTemplate: { ContainerSpec } } } };
      }
      case 'service.deploy':
        if (failNextDeploy.delete(payload.spec.name)) throw new Error('the controller restarted');
        put(payload.spec);
        return {};
      case 'service.updateLabels': {
        const labels = { ...(svc!.spec.labels ?? {}), ...payload.add };
        for (const k of payload.removeKeys ?? []) delete labels[k];
        svc!.spec = { ...svc!.spec, labels };
        return {};
      }
      case 'secret.create': {
        const value = Buffer.from(payload.dataB64, 'base64').toString('utf8');
        const have = secrets.get(payload.name);
        if (have && have.labels[HASH] !== sha(value)) throw new Error(`secret ${payload.name} already exists with different content`);
        if (!have) secrets.set(payload.name, { value, labels: { ...(payload.labels ?? {}), [HASH]: sha(value) } });
        return { id: payload.name, name: payload.name };
      }
      case 'secret.list':
        return { secrets: [...secrets].map(([name, s]) => ({ id: name, name, createdAt: 0, labels: s.labels })) };
      case 'secret.remove':
        if ([...services.values()].some((s) => s.refs.some((r) => r.source === payload.name))) throw new Error(`secret ${payload.name} is in use`);
        secrets.delete(payload.name);
        return {};
      case 'exec': {
        const s = byContainer(payload.target.containerId);
        if (!s) return { exitCode: 1, output: 'no such container' };
        if (payload.cmd[0] === 'cat') {
          const ref = s.refs.find((r) => `/run/secrets/${r.target ?? r.source}` === payload.cmd[1]);
          const v = ref ? secrets.get(ref.source)?.value : undefined;
          return v === undefined ? { exitCode: 1, output: 'No such file' } : { exitCode: 0, output: v };
        }
        const script = String(payload.cmd[2] ?? '');
        if (script.includes('pg_promote')) promoted.add(s.spec.name);
        if (script.includes('pg_is_in_recovery')) return { exitCode: 0, output: promoted.has(s.spec.name) ? 'f' : 't' };
        return { exitCode: 0, output: '' };
      }
      default:
        return {};
    }
  };

  const overrides = {
    dispatch,
    liveInventory: (o: string) => (o === orgId ? { services: [...services.values()].map(info), containers: containers() } : { services: [], containers: [] }),
    latestContainers: () => containers(),
    onlineNodeIds: () => ['n1'],
    isOnline: () => true,
    managerNode: () => 'n1',
    nodeInventory: () => [{ swarmNodeId: 'swarm-a', hostname: 'mgr-1', role: 'manager', status: 'ready', availability: 'active', labels: {} }],
    swarmNodeIdFor: () => 'swarm-a',
    nodeInfoFor: () => undefined,
  };
  return {
    services,
    secrets,
    calls,
    failNextDeploy,
    put,
    seedSecret,
    info: (name: string) => info(services.get(name)!),
    install: () => void Object.assign(hub, overrides),
    uninstall: () => {
      for (const k of Object.keys(overrides)) delete (hub as unknown as Record<string, unknown>)[k];
    },
  };
}
