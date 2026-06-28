import os from 'node:os';
import Docker from 'dockerode';
import type {
  ContainerInfo,
  ContainerState,
  NodeFacts,
  ServiceSpec,
  SwarmServiceInfo,
  SwarmNodeInfo,
} from './protocol';

/** The subset of a Docker swarm ServiceSpec the agent reads (dockerode types are loose). */
interface SwarmNetworkAttachment {
  Target?: string;
  Aliases?: string[];
}
interface SwarmSpecLike {
  Name?: string;
  Labels?: Record<string, string>;
  Mode?: { Replicated?: { Replicas?: number } };
  TaskTemplate?: {
    ContainerSpec?: { Image?: string; Env?: string[] };
    Networks?: SwarmNetworkAttachment[];
  };
  Networks?: SwarmNetworkAttachment[];
  EndpointSpec?: {
    Ports?: Array<{ TargetPort?: number; PublishedPort?: number; Protocol?: string }>;
  };
}

/** The subset of `docker info` the agent reads. */
interface DockerInfoLike {
  Name?: string;
  OperatingSystem?: string;
  Architecture?: string;
  NCPU?: number;
  MemTotal?: number;
  Swarm?: { LocalNodeState?: string; ControlAvailable?: boolean };
}

/**
 * Thin, typed wrapper over dockerode used by the node agent. Maps Docker's
 * shapes onto the swarmy wire protocol. The controller never imports this — it
 * only ever sees the protocol types the agent emits.
 */
export class DockerClient {
  readonly docker: Docker;

  constructor(socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock') {
    this.docker = new Docker({ socketPath });
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async info(): Promise<DockerInfoLike> {
    return this.docker.info() as Promise<DockerInfoLike>;
  }

  /** Gather node facts for the register handshake. */
  async getNodeFacts(agentVersion: string, protocolVersions: number[]): Promise<NodeFacts> {
    const info = await this.info();
    const version = await this.docker.version();
    const swarm = info.Swarm;
    const swarmRole: NodeFacts['swarmRole'] =
      swarm?.LocalNodeState === 'active'
        ? swarm.ControlAvailable
          ? 'manager'
          : 'worker'
        : 'none';
    return {
      hostname: info.Name || os.hostname(),
      os: `${info.OperatingSystem || os.type()}`,
      arch: info.Architecture || os.arch(),
      cpuCount: info.NCPU || os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      memTotalBytes: info.MemTotal || os.totalmem(),
      dockerVersion: version.Version,
      dockerApiVersion: version.ApiVersion,
      swarmRole,
      agentVersion,
      protocolVersions: protocolVersions as [number, ...number[]],
    };
  }

  async isManager(): Promise<boolean> {
    const info = await this.info();
    return info.Swarm?.ControlAvailable === true;
  }

  // ── Swarm membership (node-onboarding epic) ────────────────────────────

  /**
   * `docker swarm init` on the LOCAL daemon. Returns this node's swarm id plus
   * the freshly-minted worker+manager join tokens so the controller can store
   * them for later nodes. Idempotent: if already in a swarm, returns the current
   * id + tokens instead of erroring.
   */
  async swarmInit(advertiseAddr?: string): Promise<{
    swarmNodeId: string;
    managerAddr: string;
    joinTokens: { worker: string; manager: string };
  }> {
    const info = await this.info();
    if (info.Swarm?.LocalNodeState !== 'active') {
      await this.docker.swarmInit({
        ListenAddr: '0.0.0.0:2377',
        AdvertiseAddr: advertiseAddr,
      } as Parameters<Docker['swarmInit']>[0]);
    }
    return this.readSwarmState();
  }

  /** `docker swarm join` against an existing manager using a `SWMTKN-…`. */
  async swarmJoin(opts: {
    managerAddr: string;
    joinToken: string;
    advertiseAddr?: string;
  }): Promise<{ swarmNodeId: string }> {
    const info = await this.info();
    if (info.Swarm?.LocalNodeState !== 'active') {
      await this.docker.swarmJoin({
        ListenAddr: '0.0.0.0:2377',
        AdvertiseAddr: opts.advertiseAddr,
        JoinToken: opts.joinToken,
        RemoteAddrs: [opts.managerAddr],
      } as Parameters<Docker['swarmJoin']>[0]);
    }
    return { swarmNodeId: await this.localSwarmNodeId() };
  }

  /** Read the local swarm node id, advertise addr, and current join tokens. */
  async readSwarmState(): Promise<{
    swarmNodeId: string;
    managerAddr: string;
    joinTokens: { worker: string; manager: string };
  }> {
    const swarm = await this.docker.swarmInspect();
    const info = (await this.info()) as DockerInfoLike & { Swarm?: { NodeID?: string; NodeAddr?: string } };
    const tokens = (swarm.JoinTokens ?? {}) as { Worker?: string; Manager?: string };
    const nodeAddr = info.Swarm?.NodeAddr ?? '';
    return {
      swarmNodeId: info.Swarm?.NodeID ?? '',
      managerAddr: nodeAddr ? `${nodeAddr}:2377` : '',
      joinTokens: { worker: tokens.Worker ?? '', manager: tokens.Manager ?? '' },
    };
  }

  private async localSwarmNodeId(): Promise<string> {
    const info = (await this.info()) as DockerInfoLike & { Swarm?: { NodeID?: string } };
    return info.Swarm?.NodeID ?? '';
  }

  /** Snapshot all containers as protocol `ContainerInfo[]`. */
  async listContainers(all = true): Promise<ContainerInfo[]> {
    const list = await this.docker.listContainers({ all });
    return list.map((c) => ({
      id: c.Id,
      name: (c.Names?.[0] || c.Id).replace(/^\//, ''),
      image: c.Image,
      imageId: c.ImageID,
      state: normalizeState(c.State),
      status: c.Status,
      createdAt: (c.Created || 0) * 1000,
      ports: (c.Ports || []).map((p) => ({
        ip: p.IP,
        privatePort: p.PrivatePort,
        publicPort: p.PublicPort,
        protocol: (p.Type as 'tcp' | 'udp' | 'sctp') || 'tcp',
      })),
      labels: c.Labels || {},
      serviceId: c.Labels?.['com.docker.swarm.service.id'],
    }));
  }

  /** Persistent stats stream for one container (consumer decimates). */
  containerStatsStream(containerId: string) {
    return this.docker.getContainer(containerId).stats({ stream: true });
  }

  /** Docker event stream (container start/stop/die) for stream lifecycle. */
  getEvents(filters?: Record<string, string[]>) {
    return this.docker.getEvents({ filters });
  }

  // ── Swarm services (manager only) ──────────────────────────────────────

  async listServices(): Promise<SwarmServiceInfo[]> {
    const services = await this.docker.listServices();
    // Resolve overlay network IDs → names once (services reference networks by id).
    const netName = new Map<string, string>();
    try {
      for (const n of await this.docker.listNetworks()) {
        if (n.Id && n.Name) netName.set(n.Id, n.Name);
      }
    } catch {
      // best-effort
    }
    const out: SwarmServiceInfo[] = [];
    for (const s of services) {
      const id = s.ID as string;
      const spec = (s.Spec || {}) as SwarmSpecLike;
      const tt = spec.TaskTemplate ?? {};
      const mode = spec.Mode?.Replicated ? 'replicated' : 'global';
      let running = 0;
      try {
        const tasks = await this.docker.listTasks({
          filters: { service: [spec.Name as string], 'desired-state': ['running'] },
        });
        running = tasks.filter((t) => t.Status?.State === 'running').length;
      } catch {
        running = 0;
      }
      const nets = (tt.Networks ?? spec.Networks ?? []).map((n) => ({
        name: netName.get(n.Target ?? '') ?? n.Target ?? '',
        aliases: n.Aliases ?? [],
      }));
      const ports = (spec.EndpointSpec?.Ports ?? []).map((p) => ({
        target: p.TargetPort ?? 0,
        published: p.PublishedPort,
        protocol: (p.Protocol as 'tcp' | 'udp') ?? 'tcp',
      }));
      out.push({
        id,
        name: spec.Name || id,
        image: tt.ContainerSpec?.Image || '',
        mode,
        desiredReplicas: spec.Mode?.Replicated?.Replicas,
        runningReplicas: running,
        createdAt: Date.parse(s.CreatedAt || '') || 0,
        updatedAt: Date.parse(s.UpdatedAt || '') || 0,
        labels: spec.Labels || {},
        networks: nets.filter((n) => n.name),
        env: tt.ContainerSpec?.Env ?? [],
        ports,
      });
    }
    return out;
  }

  /** Live swarm node inventory (`docker node ls`) — manager-only. The Docker-truth
   *  replacement for the DB Node model's role/status/labels/resources. */
  async listNodes(): Promise<SwarmNodeInfo[]> {
    const nodes = await this.docker.listNodes();
    return nodes.map((n) => {
      const spec = (n.Spec ?? {}) as { Role?: string; Availability?: string; Labels?: Record<string, string> };
      const desc = (n.Description ?? {}) as {
        Hostname?: string;
        Platform?: { OS?: string; Architecture?: string };
        Resources?: { NanoCPUs?: number; MemoryBytes?: number };
        Engine?: { EngineVersion?: string };
      };
      const mgr = (n.ManagerStatus ?? {}) as { Leader?: boolean; Reachability?: string; Addr?: string };
      const state = ((n.Status ?? {}) as { State?: string }).State ?? 'unknown';
      return {
        swarmNodeId: (n.ID as string) || '',
        hostname: desc.Hostname ?? '',
        role: spec.Role === 'manager' ? ('manager' as const) : ('worker' as const),
        availability:
          spec.Availability === 'drain' ? ('drain' as const) : spec.Availability === 'pause' ? ('pause' as const) : ('active' as const),
        status:
          state === 'ready'
            ? ('ready' as const)
            : state === 'down'
              ? ('down' as const)
              : state === 'disconnected'
                ? ('disconnected' as const)
                : ('unknown' as const),
        leader: mgr.Leader === true,
        reachability:
          mgr.Reachability === 'reachable'
            ? ('reachable' as const)
            : mgr.Reachability === 'unreachable'
              ? ('unreachable' as const)
              : undefined,
        addr: mgr.Addr,
        engineVersion: desc.Engine?.EngineVersion,
        os: desc.Platform?.OS,
        arch: desc.Platform?.Architecture,
        cpus: desc.Resources?.NanoCPUs ? desc.Resources.NanoCPUs / 1e9 : undefined,
        memBytes: desc.Resources?.MemoryBytes,
        labels: spec.Labels ?? {},
      };
    });
  }

  async createService(spec: ServiceSpec): Promise<string> {
    const created = await this.docker.createService(toServiceCreateOptions(spec));
    return (created as unknown as { id?: string; ID?: string }).id ?? (created as { ID?: string }).ID ?? '';
  }

  async getServiceByName(name: string) {
    // Docker's `name` filter is a SUBSTRING match, so asking for `shop_web` can
    // return sibling services (`shop_web`, `shop_web_cache`, …) and asking for a
    // stack-ish fragment can return the whole stack. Resolve ONLY an exact
    // `Spec.Name` match — never fall back to an arbitrary `services[0]`, which
    // would silently apply a write (scale, label, remove) to the WRONG service.
    // Callers that may legitimately pass a service id fall back to
    // `docker.getService(id)` themselves, which resolves an id/name exactly.
    const services = await this.docker.listServices({ filters: { name: [name] } });
    const match = services.find((s) => s.Spec?.Name === name);
    return match ? this.docker.getService(match.ID as string) : null;
  }

  async scaleService(nameOrId: string, replicas: number): Promise<string> {
    const svc = (await this.getServiceByName(nameOrId)) ?? this.docker.getService(nameOrId);
    const inspect = await svc.inspect();
    const spec = inspect.Spec;
    spec.Mode = { Replicated: { Replicas: replicas } };
    await svc.update({ version: inspect.Version.Index, ...spec });
    return inspect.ID;
  }

  async restartService(nameOrId: string): Promise<string> {
    const svc = (await this.getServiceByName(nameOrId)) ?? this.docker.getService(nameOrId);
    const inspect = await svc.inspect();
    const spec = inspect.Spec;
    spec.TaskTemplate = spec.TaskTemplate || {};
    spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
    await svc.update({ version: inspect.Version.Index, ...spec });
    return inspect.ID;
  }

  async removeService(nameOrId: string): Promise<void> {
    const svc = (await this.getServiceByName(nameOrId)) ?? this.docker.getService(nameOrId);
    await svc.remove();
  }

  /** Merge/remove labels on a live service (how swarmy persists config — Docker-truth). */
  async updateServiceLabels(
    nameOrId: string,
    add: Record<string, string>,
    removeKeys: string[] = [],
  ): Promise<string> {
    const svc = (await this.getServiceByName(nameOrId)) ?? this.docker.getService(nameOrId);
    const inspect = await svc.inspect();
    const spec = inspect.Spec as { Labels?: Record<string, string> };
    spec.Labels = { ...(spec.Labels ?? {}), ...add };
    for (const k of removeKeys) delete spec.Labels[k];
    await svc.update({ version: inspect.Version.Index, ...(spec as Record<string, unknown>) });
    return inspect.ID;
  }

  async updateSwarmNode(
    swarmNodeId: string,
    opts: { availability?: 'active' | 'pause' | 'drain'; labels?: Record<string, string> },
  ): Promise<void> {
    const node = this.docker.getNode(swarmNodeId);
    const inspect = await node.inspect();
    const spec = inspect.Spec || {};
    if (opts.availability) spec.Availability = opts.availability;
    if (opts.labels) spec.Labels = { ...(spec.Labels || {}), ...opts.labels };
    await node.update({ version: inspect.Version.Index, ...spec });
  }

  async pullImage(
    image: string,
    authconfig?: { username: string; password: string; serveraddress?: string },
    onProgress?: (line: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.docker.pull(image, { authconfig }, (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err ?? new Error('no pull stream'));
        let digest = '';
        this.docker.modem.followProgress(
          stream,
          (doneErr: Error | null) => (doneErr ? reject(doneErr) : resolve(digest)),
          (event: { status?: string; aux?: { Digest?: string } }) => {
            if (event.aux?.Digest) digest = event.aux.Digest;
            if (onProgress && event.status) onProgress(event.status);
          },
        );
      });
    });
  }
}

function normalizeState(state: string): ContainerState {
  const s = (state || '').toLowerCase();
  const known: ContainerState[] = [
    'created',
    'running',
    'paused',
    'restarting',
    'removing',
    'exited',
    'dead',
  ];
  return (known as string[]).includes(s) ? (s as ContainerState) : 'dead';
}

/** Map a swarmy `ServiceSpec` onto a dockerode `createService` body. */
export function toServiceCreateOptions(spec: ServiceSpec): Docker.CreateServiceOptions {
  const env = spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined;
  const mode = spec.mode?.global
    ? { Global: {} }
    : { Replicated: { Replicas: spec.mode?.replicated?.replicas ?? 1 } };

  const toNanoCpus = (cpus?: number) => (cpus != null ? Math.round(cpus * 1e9) : undefined);
  const refFile = (r: { target?: string; source: string; uid?: string; gid?: string; mode?: number }) => ({
    Name: r.target ?? r.source,
    UID: r.uid ?? '0',
    GID: r.gid ?? '0',
    Mode: r.mode ?? 0o444,
  });

  return {
    Name: spec.name,
    Labels: spec.labels,
    TaskTemplate: {
      ContainerSpec: {
        Image: spec.image,
        Command: spec.command,
        Args: spec.args,
        Env: env,
        Mounts: spec.mounts?.map((m) => ({
          Type: m.type,
          Source: m.source,
          Target: m.target,
          ReadOnly: m.readOnly,
        })),
        Healthcheck: spec.healthcheck
          ? spec.healthcheck.disable
            ? { Test: ['NONE'] }
            : {
                Test: spec.healthcheck.test,
                Interval: spec.healthcheck.intervalNs,
                Timeout: spec.healthcheck.timeoutNs,
                StartPeriod: spec.healthcheck.startPeriodNs,
                Retries: spec.healthcheck.retries,
              }
          : undefined,
        StopGracePeriod: spec.stopGracePeriodNs,
        Configs: spec.configs?.map((c) => ({ ConfigName: c.source, File: refFile(c) })),
        Secrets: spec.secrets?.map((s) => ({ SecretName: s.source, File: refFile(s) })),
      },
      RestartPolicy: spec.restartPolicy
        ? {
            Condition: spec.restartPolicy.condition,
            MaxAttempts: spec.restartPolicy.maxAttempts,
          }
        : undefined,
      Resources: spec.resources
        ? {
            Limits: spec.resources.limits
              ? {
                  NanoCPUs: toNanoCpus(spec.resources.limits.cpus),
                  MemoryBytes: spec.resources.limits.memoryBytes,
                }
              : undefined,
            Reservations: spec.resources.reservations
              ? {
                  NanoCPUs: toNanoCpus(spec.resources.reservations.cpus),
                  MemoryBytes: spec.resources.reservations.memoryBytes,
                }
              : undefined,
          }
        : undefined,
      Placement: spec.placement
        ? {
            Constraints: spec.placement.constraints,
            Preferences: spec.placement.preferences?.map((p) => {
              const eq = p.indexOf('=');
              return { Spread: { SpreadDescriptor: eq === -1 ? p : p.slice(eq + 1) } };
            }),
            MaxReplicas: spec.placement.maxReplicasPerNode,
          }
        : undefined,
      Networks: spec.networks?.map((n) => ({ Target: n })),
    },
    Mode: mode,
    EndpointSpec: spec.ports
      ? {
          Ports: spec.ports.map((p) => ({
            TargetPort: p.target,
            PublishedPort: p.published,
            Protocol: p.protocol,
            PublishMode: p.mode === 'host' ? 'host' : 'ingress',
          })),
        }
      : undefined,
  } as Docker.CreateServiceOptions;
}
