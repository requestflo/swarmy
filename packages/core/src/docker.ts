import os from 'node:os';
import Docker from 'dockerode';
import type {
  ContainerInfo,
  ContainerState,
  NodeFacts,
  ServiceSpec,
  SwarmServiceInfo,
  SwarmNodeInfo,
  SwarmState,
} from './protocol';
import { isSwarmyStackNetwork, summarizeTasks, SWARMY_OVERLAY_NETWORK, type TaskLike } from './inventory';
import { isPlatformNetwork, OVERLAY_MTU_OPTION, stripPlatformAliases, SWARMY_CONTROL_NETWORK } from './network-policy';

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
    ContainerSpec?: {
      Image?: string;
      Env?: string[];
      Secrets?: Array<{ SecretName?: string }>;
      Configs?: Array<{ ConfigName?: string }>;
      Mounts?: Array<{ Type?: string; Source?: string; Target?: string }>;
    };
    Networks?: SwarmNetworkAttachment[];
  };
  Networks?: SwarmNetworkAttachment[];
  EndpointSpec?: {
    Ports?: Array<{ TargetPort?: number; PublishedPort?: number; Protocol?: string }>;
  };
}

/** The subset of a Docker secret/config list entry the agent reads. */
interface SwarmResourceLike {
  ID?: string;
  CreatedAt?: string;
  Spec?: { Name?: string; Labels?: Record<string, string>; Data?: string };
}

/** The subset of `GET /swarm` the recovery commands read (dockerode types are loose). */
interface SwarmInspectLike {
  Version?: { Index?: number };
  Spec?: Record<string, unknown>;
  JoinTokens?: { Worker?: string; Manager?: string };
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
/** dockerode auth object → `X-Registry-Auth` (base64 JSON) on service create/update. */
export interface ServiceAuthConfig {
  username: string;
  password: string;
  serveraddress?: string;
}

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

  /**
   * Local swarm membership (`docker info` → `Swarm.LocalNodeState`). `active`
   * means a working swarm member; anything else means the node cannot run
   * workloads even if its agent is up. Unknown/missing states map to `inactive`.
   */
  async swarmState(): Promise<SwarmState> {
    try {
      const state = (await this.info()).Swarm?.LocalNodeState ?? 'inactive';
      const known: SwarmState[] = ['active', 'pending', 'locked', 'error', 'inactive'];
      return known.includes(state as SwarmState) ? (state as SwarmState) : 'inactive';
    } catch {
      return 'inactive';
    }
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
    dataPathAddr?: string;
  }): Promise<{ swarmNodeId: string }> {
    const info = await this.info();
    if (info.Swarm?.LocalNodeState !== 'active') {
      await this.docker.swarmJoin({
        ListenAddr: '0.0.0.0:2377',
        AdvertiseAddr: opts.advertiseAddr,
        ...(opts.dataPathAddr ? { DataPathAddr: opts.dataPathAddr } : {}),
        JoinToken: opts.joinToken,
        RemoteAddrs: [opts.managerAddr],
      } as Parameters<Docker['swarmJoin']>[0]);
    }
    return { swarmNodeId: await this.localSwarmNodeId() };
  }

  /** `docker swarm leave` (never forced — a manager must be demoted first). */
  async swarmLeave(): Promise<void> {
    await this.docker.swarmLeave({ force: false });
  }

  /** This node's current swarm advertise address (`''` off-swarm). */
  async localSwarmAddr(): Promise<string> {
    const info = (await this.info()) as DockerInfoLike & { Swarm?: { NodeAddr?: string } };
    return info.Swarm?.NodeAddr ?? '';
  }

  /** `docker node rm --force <id>` (manager only). */
  async removeSwarmNode(swarmNodeId: string): Promise<void> {
    await this.docker.getNode(swarmNodeId).remove({ force: true });
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

  /**
   * `POST /swarm/update` with the CURRENT spec (mutated in place) + rotation
   * flags (manager only). docker-modem splits `_query`/`_body`, which dockerode's
   * loose `swarmUpdate` typing doesn't know about — hence the cast.
   */
  private async applySwarmUpdate(
    mutateSpec: (spec: Record<string, unknown>) => void,
    query: Record<string, boolean> = {},
  ): Promise<void> {
    const swarm = (await this.docker.swarmInspect()) as SwarmInspectLike;
    const spec = (swarm.Spec ?? {}) as Record<string, unknown>;
    mutateSpec(spec);
    await this.docker.swarmUpdate({
      _query: { version: swarm.Version?.Index ?? 0, ...query },
      _body: spec,
    } as unknown as Parameters<Docker['swarmUpdate']>[0]);
  }

  /**
   * Toggle manager auto-lock (`AutoLockManagers`). Enabling returns the
   * freshly-minted unlock key so the caller can store it — Docker only hands
   * it out via `GET /swarm/unlockkey`, never in the update response.
   */
  async swarmSetAutolock(enabled: boolean): Promise<{ autolock: boolean; unlockKey?: string }> {
    await this.applySwarmUpdate((spec) => {
      const enc = (spec.EncryptionConfig ?? {}) as Record<string, unknown>;
      spec.EncryptionConfig = { ...enc, AutoLockManagers: enabled };
    });
    if (!enabled) return { autolock: false };
    const unlockKey = await this.swarmUnlockKey();
    return { autolock: true, unlockKey: unlockKey || undefined };
  }

  /** Current unlock key (`GET /swarm/unlockkey`) — dockerode 4.x has no wrapper,
   *  so dial the engine endpoint directly (manager only). */
  async swarmUnlockKey(): Promise<string> {
    const res = await new Promise<unknown>((resolve, reject) => {
      this.docker.modem.dial(
        {
          path: '/swarm/unlockkey',
          method: 'GET',
          statusCodes: { 200: true, 406: 'node is not a swarm manager', 500: 'server error' },
        },
        (err: Error | null, data: unknown) => (err ? reject(err) : resolve(data)),
      );
    });
    return (res as { UnlockKey?: string } | null)?.UnlockKey ?? '';
  }

  /**
   * Trim the build cache down to `keepBytes` (`POST /build/prune`, least
   * recently used first; `all` so unused tagged-build cache counts too).
   * Sends both `keep-storage` (API < 1.48) and `reserved-space` (1.48+);
   * the engine ignores the one it doesn't know. dockerode 4.x has no wrapper.
   */
  async pruneBuildCache(keepBytes: number): Promise<{ reclaimedBytes: number }> {
    const res = await new Promise<unknown>((resolve, reject) => {
      this.docker.modem.dial(
        {
          path: '/build/prune?',
          method: 'POST',
          options: { all: true, 'keep-storage': keepBytes, 'reserved-space': keepBytes },
          statusCodes: { 200: true, 500: 'server error' },
        },
        (err: Error | null, data: unknown) => (err ? reject(err) : resolve(data)),
      );
    });
    return { reclaimedBytes: Number((res as { SpaceReclaimed?: number } | null)?.SpaceReclaimed ?? 0) };
  }

  /** Rotate the worker and/or manager join tokens; returns the post-rotation pair. */
  async swarmRotateTokens(
    roles: Array<'manager' | 'worker'>,
  ): Promise<{ worker: string; manager: string }> {
    await this.applySwarmUpdate(() => undefined, {
      rotateWorkerToken: roles.includes('worker'),
      rotateManagerToken: roles.includes('manager'),
    });
    const swarm = (await this.docker.swarmInspect()) as SwarmInspectLike;
    const tokens = swarm.JoinTokens ?? {};
    return { worker: tokens.Worker ?? '', manager: tokens.Manager ?? '' };
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
      // Volumes report their NAME (anonymous volumes: the hash name) so the
      // managed-DB storage migration can bind the exact volume a task used.
      mounts: (c.Mounts || [])
        .filter((m) => Boolean(m.Destination))
        .map((m) => ({
          ...(m.Type ? { type: m.Type } : {}),
          ...((m.Type === 'volume' ? m.Name : m.Source) ? { source: (m.Type === 'volume' ? m.Name : m.Source)! } : {}),
          target: m.Destination,
        })),
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
      let taskHealth: SwarmServiceInfo['taskHealth'];
      try {
        // Full task history (incl. shut-down/failed tasks, as `docker service ps`
        // shows) — the failures are what tell a crash loop from a slow deploy.
        const tasks = (await this.docker.listTasks({
          filters: { service: [spec.Name as string] },
        })) as TaskLike[];
        running = tasks.filter((t) => t.DesiredState === 'running' && t.Status?.State === 'running').length;
        taskHealth = summarizeTasks(tasks);
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
        secrets: (tt.ContainerSpec?.Secrets ?? []).map((r) => r.SecretName ?? '').filter(Boolean),
        configs: (tt.ContainerSpec?.Configs ?? []).map((r) => r.ConfigName ?? '').filter(Boolean),
        mounts: (tt.ContainerSpec?.Mounts ?? [])
          .filter((m) => Boolean(m.Target))
          .map((m) => ({
            ...(m.Type ? { type: m.Type } : {}),
            ...(m.Source ? { source: m.Source } : {}),
            target: m.Target!,
          })),
        ...(taskHealth ? { taskHealth } : {}),
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

  // ── Swarm secrets / configs (manager only, platform buildout spine) ─────
  // Values are write-only for secrets (Docker never returns secret data);
  // configs ARE readable back via `inspectConfig` (Spec.Data, base64).

  private mapSwarmResource(r: SwarmResourceLike): {
    id: string;
    name: string;
    createdAt: number;
    labels: Record<string, string>;
  } {
    return {
      id: r.ID ?? '',
      name: r.Spec?.Name ?? '',
      createdAt: Date.parse(r.CreatedAt ?? '') || 0,
      labels: r.Spec?.Labels ?? {},
    };
  }

  async listSecrets(): Promise<
    Array<{ id: string; name: string; createdAt: number; labels: Record<string, string> }>
  > {
    const secrets = (await this.docker.listSecrets()) as unknown as SwarmResourceLike[];
    return secrets.map((s) => this.mapSwarmResource(s));
  }

  /** Create a Docker secret from base64 data. Errors if the name already exists. */
  async createSecret(name: string, dataB64: string, labels?: Record<string, string>): Promise<string> {
    const created = (await this.docker.createSecret({
      Name: name,
      Data: dataB64,
      Labels: labels,
    })) as { id?: string; ID?: string };
    return created.id ?? created.ID ?? '';
  }

  async removeSecret(nameOrId: string): Promise<void> {
    const match = (await this.listSecrets()).find((s) => s.name === nameOrId);
    await this.docker.getSecret(match?.id ?? nameOrId).remove();
  }

  async listConfigs(): Promise<
    Array<{ id: string; name: string; createdAt: number; labels: Record<string, string> }>
  > {
    const configs = (await this.docker.listConfigs()) as unknown as SwarmResourceLike[];
    return configs.map((c) => this.mapSwarmResource(c));
  }

  /** Create a Docker config from base64 data. Errors if the name already exists. */
  async createConfig(name: string, dataB64: string, labels?: Record<string, string>): Promise<string> {
    const created = (await this.docker.createConfig({
      Name: name,
      Data: dataB64,
      Labels: labels,
    })) as { id?: string; ID?: string };
    return created.id ?? created.ID ?? '';
  }

  async removeConfig(nameOrId: string): Promise<void> {
    const match = (await this.listConfigs()).find((c) => c.name === nameOrId);
    await this.docker.getConfig(match?.id ?? nameOrId).remove();
  }

  /** Full config content (`Spec.Data`, base64) + metadata — configs are readable. */
  async inspectConfig(nameOrId: string): Promise<{
    id: string;
    name: string;
    dataB64: string;
    createdAt: number;
    labels: Record<string, string>;
  }> {
    const match = (await this.listConfigs()).find((c) => c.name === nameOrId);
    const raw = (await this.docker
      .getConfig(match?.id ?? nameOrId)
      .inspect()) as unknown as SwarmResourceLike;
    return { ...this.mapSwarmResource(raw), dataB64: raw.Spec?.Data ?? '' };
  }

  /**
   * Idempotently ensure an overlay network exists, returning its id. Looks the
   * network up by EXACT name first (Docker's listNetworks `name` filter is a
   * substring match, so we filter in-process); if absent, creates an attachable
   * overlay so swarm services AND ad-hoc containers can join. Fixes the
   * "network <x> not found" failure when deploying a service (Caddy/CoreDNS) to
   * a freshly-named overlay the swarm hasn't created yet. Overlay networks
   * require a manager — route this command to a manager node.
   */
  async ensureNetwork(
    name: string,
    opts: {
      driver?: string;
      attachable?: boolean;
      labels?: Record<string, string>;
      /** Driver options (`com.docker.network.driver.mtu`, `encrypted`, …). Create-time only. */
      options?: Record<string, string>;
    } = {},
  ): Promise<string> {
    const nets = await this.docker.listNetworks();
    const existing = nets.find((n) => n.Name === name)?.Id;
    if (existing) return existing;
    const driver = opts.driver ?? 'overlay';
    // An overlay created without an explicit MTU inherits the platform
    // overlays' (the installer sets it when the swarm data path rides a
    // WireGuard mesh) — so every swarmy-created network fits the tunnel even
    // when a caller doesn't know about the mesh.
    const options = driver === 'overlay' ? withInheritedMtu(opts.options, nets) : opts.options;
    const findByName = async (): Promise<string | undefined> => {
      const again = await this.docker.listNetworks();
      return again.find((n) => n.Name === name)?.Id;
    };
    try {
      const net = await this.docker.createNetwork({
        Name: name,
        Driver: driver,
        Attachable: opts.attachable ?? true,
        CheckDuplicate: true,
        Labels: opts.labels,
        ...(options && Object.keys(options).length ? { Options: options } : {}),
      });
      return net.id;
    } catch (e) {
      // Lost a create race (another deploy created it concurrently)? Re-resolve
      // by name before surfacing the error so this stays idempotent.
      const raced = await findByName();
      if (raced) return raced;
      throw e;
    }
  }

  /**
   * Remove the overlay networks swarmy created for compose stack `stack`
   * (`isSwarmyStackNetwork`: stack-namespace + `swarmy.managed=true` labels —
   * never external networks, never the shared `swarmy` overlay). Right after a
   * stack's services are removed their tasks still hold endpoints for a few
   * seconds, so each removal retries; a network still in use by something else
   * (e.g. another stack attached to it) is reported as failed, never forced.
   */
  async removeStackNetworks(
    stack: string,
    opts: { attempts?: number; delayMs?: number } = {},
  ): Promise<{ removed: string[]; failed: { name: string; error: string }[] }> {
    const attempts = opts.attempts ?? 10;
    const delayMs = opts.delayMs ?? 2_000;
    const nets = (await this.docker.listNetworks()).filter((n) => isSwarmyStackNetwork(n, stack));
    const removed: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const n of nets) {
      let lastErr = '';
      for (let i = 0; i < attempts; i++) {
        try {
          await this.docker.getNetwork(n.Id).remove();
          lastErr = '';
          break;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404) {
            lastErr = '';
            break; // already gone
          }
          lastErr = e instanceof Error ? e.message : String(e);
          if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      if (lastErr) failed.push({ name: n.Name, error: lastErr });
      else removed.push(n.Name);
    }
    return { removed, failed };
  }

  /**
   * Create a swarm service. `authconfig` (optional) becomes the `X-Registry-Auth`
   * header, so the swarm stores the pull credentials with the service and every
   * node can pull a private image (`docker service create --with-registry-auth`).
   */
  async createService(spec: ServiceSpec, authconfig?: ServiceAuthConfig): Promise<string> {
    const options = await this.prepareServiceOptions(spec);
    const created = authconfig
      ? // dockerode's (auth, opts) overload is untyped; passing auth positionally
        // keeps it OUT of the JSON body (header only).
        await (this.docker.createService as unknown as (a: ServiceAuthConfig, o: unknown) => Promise<unknown>).call(
          this.docker,
          authconfig,
          options,
        )
      : await this.docker.createService(options);
    return (created as { id?: string; ID?: string }).id ?? (created as { ID?: string }).ID ?? '';
  }

  /**
   * Update a service with a full options body, optionally re-stamping the pull
   * credentials (`docker service update --with-registry-auth`). Without auth the
   * swarm keeps whatever credentials the service already carries.
   */
  async updateServiceWithAuth(
    svc: Docker.Service,
    body: Record<string, unknown>,
    authconfig?: ServiceAuthConfig,
  ): Promise<void> {
    if (!authconfig) {
      await svc.update(body);
      return;
    }
    await (svc.update as unknown as (a: ServiceAuthConfig, o: unknown) => Promise<unknown>).call(svc, authconfig, body);
  }

  /**
   * Spec → API options with names resolved to ids (networks, secrets, configs).
   * BOTH deploy paths must use this: the swarm API rejects name-only secret/
   * config references ("malformed secret reference") on update exactly like on
   * create, so an update built from raw toServiceCreateOptions() breaks for any
   * service that mounts a secret (e.g. swarmy-dns's admin token).
   */
  async prepareServiceOptions(spec: ServiceSpec): Promise<Docker.CreateServiceOptions> {
    const resolved = await this.resolveSpecNetworks(spec);
    const options = toServiceCreateOptions(resolved);
    await this.resolveSecretConfigIds(options);
    return options;
  }

  /**
   * Fill in SecretID/ConfigID on the create options' references. The swarm API
   * rejects a reference that carries only the name ("malformed secret
   * reference") — unlike networks, names are never resolved server-side.
   */
  private async resolveSecretConfigIds(options: Docker.CreateServiceOptions): Promise<void> {
    const tt = (options as { TaskTemplate?: { ContainerSpec?: { Secrets?: Array<{ SecretID?: string; SecretName?: string }>; Configs?: Array<{ ConfigID?: string; ConfigName?: string }> } } }).TaskTemplate;
    const secrets = tt?.ContainerSpec?.Secrets;
    const configs = tt?.ContainerSpec?.Configs;
    if (secrets?.length) {
      const byName = new Map((await this.listSecrets()).map((s) => [s.name, s.id]));
      for (const ref of secrets) {
        if (!ref.SecretID && ref.SecretName) {
          const id = byName.get(ref.SecretName);
          if (!id) throw new Error(`secret not found: ${ref.SecretName}`);
          ref.SecretID = id;
        }
      }
    }
    if (configs?.length) {
      const byName = new Map((await this.listConfigs()).map((c) => [c.name, c.id]));
      for (const ref of configs) {
        if (!ref.ConfigID && ref.ConfigName) {
          const id = byName.get(ref.ConfigName);
          if (!id) throw new Error(`config not found: ${ref.ConfigName}`);
          ref.ConfigID = id;
        }
      }
    }
  }

  /** Resolve network NAMES → ids in a spec. Docker's TaskTemplate.Networks resolves
   *  ids reliably but is flaky resolving freshly-created overlay names at create time. */
  private async resolveSpecNetworks(input: ServiceSpec): Promise<ServiceSpec> {
    // Safety floor: nothing the agent deploys may register a DNS alias on the
    // shared/private platform networks (impersonation — see network-policy).
    const spec = stripPlatformAliases(input);
    if (!spec.networks?.length) return spec;
    const byName = new Map<string, string>();
    try {
      for (const n of await this.docker.listNetworks()) {
        if (n.Name && n.Id) byName.set(n.Name, n.Id);
      }
    } catch {
      return spec; // best-effort: fall back to names
    }
    const resolve = (n: string) => byName.get(n) ?? n;
    const networkAliases = spec.networkAliases
      ? Object.fromEntries(Object.entries(spec.networkAliases).map(([n, a]) => [resolve(n), a]))
      : undefined;
    return {
      ...spec,
      networks: spec.networks.map(resolve),
      ...(networkAliases ? { networkAliases } : {}),
    };
  }

  /** Ids of the platform overlays (`swarmy`, `swarmy-control`) — alias-free zones. */
  async platformNetworkIds(): Promise<Set<string>> {
    try {
      const nets = await this.docker.listNetworks();
      return new Set(nets.filter((n) => n.Name && isPlatformNetwork(n.Name) && n.Id).map((n) => n.Id as string));
    } catch {
      return new Set();
    }
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

  /**
   * Full raw `docker service inspect` for one service (complete spec + task/
   * update status) — the structured inventory only carries summary fields, so
   * this powers the details/debug view. Resolves by exact name first, then id.
   */
  async inspectService(nameOrId: string): Promise<unknown> {
    const svc = (await this.getServiceByName(nameOrId)) ?? this.docker.getService(nameOrId);
    return svc.inspect();
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
    opts: {
      availability?: 'active' | 'pause' | 'drain';
      labels?: Record<string, string>;
      /** WS2 promote/demote — maps straight onto the node spec's `Role`. */
      role?: 'manager' | 'worker';
    },
  ): Promise<void> {
    const node = this.docker.getNode(swarmNodeId);
    const inspect = await node.inspect();
    const spec = inspect.Spec || {};
    if (opts.availability) spec.Availability = opts.availability;
    if (opts.labels) spec.Labels = { ...(spec.Labels || {}), ...opts.labels };
    if (opts.role) spec.Role = opts.role;
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

/**
 * Fill `com.docker.network.driver.mtu` from the platform overlays (`swarmy-control`,
 * then `swarmy`) when the caller set none. PURE — exported for tests.
 */
export function withInheritedMtu(
  options: Record<string, string> | undefined,
  nets: Array<{ Name?: string; Options?: Record<string, string> | null }>,
): Record<string, string> | undefined {
  if (options?.[OVERLAY_MTU_OPTION]) return options;
  for (const template of [SWARMY_CONTROL_NETWORK, SWARMY_OVERLAY_NETWORK]) {
    const mtu = nets.find((n) => n.Name === template)?.Options?.[OVERLAY_MTU_OPTION];
    if (mtu) return { ...(options ?? {}), [OVERLAY_MTU_OPTION]: mtu };
  }
  return options;
}

/**
 * On an UPDATE whose spec does not express `networkAliases`, carry the live
 * service's per-network aliases onto the new options (matched by network
 * Target id). Lossy rebuilds (env/image/network patches built from the
 * inventory) therefore never strip the `<stack>_default` short-name alias a
 * compose deploy set. A spec that DOES carry `networkAliases` is authoritative.
 * PURE — mutates and returns `options`.
 */
export function carryNetworkAliases(
  options: { TaskTemplate?: { Networks?: Array<{ Target?: string; Aliases?: string[] }> } },
  spec: Pick<ServiceSpec, 'networkAliases'>,
  live: Array<{ Target?: string; Aliases?: string[] }> | undefined,
): typeof options {
  if (spec.networkAliases || !live?.length) return options;
  const byTarget = new Map(
    live.filter((n) => n.Target && n.Aliases?.length).map((n) => [n.Target!, n.Aliases!]),
  );
  for (const n of options.TaskTemplate?.Networks ?? []) {
    const aliases = n.Target ? byTarget.get(n.Target) : undefined;
    if (aliases && !n.Aliases?.length) n.Aliases = [...aliases];
  }
  return options;
}

/**
 * Remove DNS aliases from every TaskTemplate network whose Target is a platform
 * overlay id — run AFTER {@link carryNetworkAliases} so a live alias an older
 * deploy put on `swarmy` is dropped on the next update instead of carried.
 * PURE — mutates and returns `options`.
 */
export function dropAliasesOnTargets(
  options: { TaskTemplate?: { Networks?: Array<{ Target?: string; Aliases?: string[] }> } },
  targets: ReadonlySet<string>,
): typeof options {
  for (const n of options.TaskTemplate?.Networks ?? []) {
    if (n.Target && targets.has(n.Target) && n.Aliases) delete n.Aliases;
  }
  return options;
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

/**
 * Bounded default log driver for every service swarmy deploys (system AND user
 * services) — node disks must never fill with container logs. `json-file`
 * keeps `docker logs` / swarmy's log streaming working; 10 MiB × 3 files caps
 * each container at ~30 MiB. A spec's own `logging` always wins.
 */
export const DEFAULT_LOG_DRIVER: { Name: string; Options: Record<string, string> } = {
  Name: 'json-file',
  Options: { 'max-size': '10m', 'max-file': '3' },
};

/**
 * The same bound for a plain container swarmy starts outside a service (the
 * agent itself on self-update, the mesh sidecar) — `HostConfig.LogConfig`.
 */
export function defaultContainerLogConfig(): { Type: string; Config: Record<string, string> } {
  return { Type: DEFAULT_LOG_DRIVER.Name, Config: { ...DEFAULT_LOG_DRIVER.Options } };
}

/**
 * Keep a container's operator-chosen log config across a re-create, unless it
 * is the unbounded daemon default (json-file / local with no options) — then
 * swarmy's bounded default. PURE.
 */
export function boundedLogConfig(
  live: { Type?: string; Config?: Record<string, string> } | null | undefined,
): { Type: string; Config: Record<string, string> } {
  if (live?.Type && (Object.keys(live.Config ?? {}).length > 0 || !['json-file', ''].includes(live.Type))) {
    return { Type: live.Type, Config: { ...(live.Config ?? {}) } };
  }
  return defaultContainerLogConfig();
}

/** A spec's `logging` → the swarm `TaskTemplate.LogDriver` (default when omitted). */
export function logDriverFor(spec: Pick<ServiceSpec, 'logging'>): { Name: string; Options: Record<string, string> } {
  if (!spec.logging) return { Name: DEFAULT_LOG_DRIVER.Name, Options: { ...DEFAULT_LOG_DRIVER.Options } };
  return { Name: spec.logging.driver, Options: { ...(spec.logging.options ?? {}) } };
}

/**
 * On an UPDATE whose spec does not express `logging`, keep the live service's
 * log driver when it has one — so a lossy rebuild (env/image patch from the
 * inventory) never swaps an operator's loki/fluentd driver for swarmy's
 * default. A live service with NO driver gets the bounded default (that is
 * how existing services pick up log rotation on their next deploy). A spec
 * that DOES carry `logging` is authoritative. PURE — mutates and returns
 * `options`.
 */
export function carryLogDriver(
  options: { TaskTemplate?: { LogDriver?: { Name?: string; Options?: Record<string, string> } } },
  spec: Pick<ServiceSpec, 'logging'>,
  live: { Name?: string; Options?: Record<string, string> } | undefined,
): typeof options {
  if (spec.logging || !live?.Name || !options.TaskTemplate) return options;
  options.TaskTemplate.LogDriver = { Name: live.Name, Options: { ...(live.Options ?? {}) } };
  return options;
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
      Networks: spec.networks?.map((n) => {
        const aliases = spec.networkAliases?.[n];
        return aliases?.length ? { Target: n, Aliases: aliases } : { Target: n };
      }),
      LogDriver: logDriverFor(spec),
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
