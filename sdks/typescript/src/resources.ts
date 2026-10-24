import type { HttpTransport } from './http.js';
import type {
  AddDomainRequest,
  App,
  AppDeployResult,
  AppDriftList,
  AppEnforceDrift,
  AppList,
  AppPlan,
  AppPlanList,
  AppPromoteResult,
  AppRequireApproval,
  ConfirmAppActionsResult,
  DeployEvents,
  DeploymentStatus,
  IngressDomainDetail,
  IngressSettings,
  NodeAvailability,
  NodeLabels,
  PurgeAppDataResult,
  UpdateDomainRequest,
  UpdateIngressSettingsRequest,
  LogLine,
  LogLineList,
  PatchServiceEnvResult,
  ErrorProject,
  PreviewResult,
  StackErrorsStatus,
  ServiceEnv,
  StackTelemetry,
  CreateJoinTokenRequest,
  CreateServiceRequest,
  DeployStackRequest,
  JoinTokenIssued,
  JoinTokenList,
  Revoked,
  UpdateServiceRequest,
  DeploymentRef,
  IngressDomain,
  IngressDomainList,
  Node,
  NodeList,
  Removed,
  Service,
  ServiceList,
  Stack,
  StackConnection,
  StackEndpoints,
  StackList,
  StackRemoved,
} from './models.js';

/** Options shared by all paginated list calls. */
export interface ListOptions {
  /** Opaque cursor from a previous response's `next_cursor`. */
  cursor?: string;
  /** Page size hint. */
  limit?: number;
}

function listQuery(opts?: ListOptions): Record<string, string | number | undefined> {
  return { cursor: opts?.cursor, limit: opts?.limit };
}

export class ServicesResource {
  constructor(private readonly http: HttpTransport) {}

  list(opts?: ListOptions): Promise<ServiceList> {
    return this.http.request<ServiceList>('GET', '/services', { query: listQuery(opts) });
  }

  get(id: string): Promise<Service> {
    return this.http.request<Service>('GET', `/services/${encodeURIComponent(id)}`);
  }

  /** Create a service. Returns a deployment reference (202 Accepted, async). */
  create(body: CreateServiceRequest): Promise<DeploymentRef> {
    return this.http.request<DeploymentRef>('POST', '/services', { body });
  }

  /** Scale a service to `replicas`. Async (202 Accepted). */
  scale(id: string, replicas: number): Promise<DeploymentRef> {
    return this.http.request<DeploymentRef>('POST', `/services/${encodeURIComponent(id)}/scale`, {
      body: { replicas },
    });
  }

  /**
   * Change a running service: only the fields sent change, the rest keep their
   * live values. Async (202 Accepted). It runs the same admission checks as a
   * deploy, so a guardrail can refuse it (`SwarmyApiError` 412, `POLICY_DENIED`).
   */
  update(id: string, body: UpdateServiceRequest): Promise<DeploymentRef> {
    return this.http.request<DeploymentRef>('PATCH', `/services/${encodeURIComponent(id)}`, { body });
  }

  /** Restart a service. Async (202 Accepted). */
  restart(id: string): Promise<DeploymentRef> {
    return this.http.request<DeploymentRef>('POST', `/services/${encodeURIComponent(id)}/restart`);
  }

  remove(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/services/${encodeURIComponent(id)}`);
  }

  /** Async iterator over every service across all pages. */
  iterate(opts?: ListOptions): AsyncIterableIterator<Service> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }

  /**
   * The service's environment. Secret values are `null` unless
   * `revealSecrets` is set AND the key holds the `secrets.read` scope AND
   * policy permits it (each reveal is audited).
   */
  env(id: string, opts: { revealSecrets?: boolean } = {}): Promise<ServiceEnv> {
    return this.http.request<ServiceEnv>('GET', `/services/${encodeURIComponent(id)}/env`, {
      query: { reveal_secrets: opts.revealSecrets ? 'true' : undefined },
    });
  }

  /** Merge-patch the environment; keys not named are kept. Async rollout (202). */
  patchEnv(
    id: string,
    body: { set?: Record<string, string>; secrets?: Record<string, string>; unset?: string[] },
  ): Promise<PatchServiceEnvResult> {
    return this.http.request<PatchServiceEnvResult>('PATCH', `/services/${encodeURIComponent(id)}/env`, { body });
  }

  /** The last `tail` log lines (oldest first). */
  logs(id: string, opts: { tail?: number; since?: number } = {}): Promise<LogLineList> {
    return this.http.request<LogLineList>('GET', `/services/${encodeURIComponent(id)}/logs`, {
      query: { tail: opts.tail, since: opts.since },
    });
  }

  /** Follow the logs (Server-Sent Events) until `signal` aborts or the server ends the stream. */
  async *followLogs(id: string, opts: { tail?: number; since?: number; signal?: AbortSignal } = {}): AsyncGenerator<LogLine> {
    const res = await this.http.raw('GET', `/services/${encodeURIComponent(id)}/logs/stream`, {
      query: { tail: opts.tail, since: opts.since },
      accept: 'text/event-stream',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.body) return;
    for await (const data of sseData(res.body as ReadableStream<Uint8Array>)) {
      try {
        yield JSON.parse(data) as LogLine;
      } catch {
        // a malformed event is skipped, not fatal
      }
    }
  }
}

/** Parse a Server-Sent Events body into its `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
    if (data.length) yield data.join('\n');
  } finally {
    reader.releaseLock();
  }
}

export class AppsResource {
  constructor(private readonly http: HttpTransport) {}

  list(): Promise<AppList> {
    return this.http.request<AppList>('GET', '/apps');
  }

  /** Find one app by repo id, app name, repo full name, or repo URL. */
  async find(ref: string): Promise<App | undefined> {
    const { data } = await this.list();
    return data.find((a) => a.repo_id === ref || a.app_name === ref || a.full_name === ref || a.url === ref);
  }

  /** Plan + apply the head of `branch` (default: the production branch). */
  deploy(repoId: string, body: { branch?: string } = {}): Promise<AppDeployResult> {
    return this.http.request<AppDeployResult>('POST', `/apps/${encodeURIComponent(repoId)}/deploy`, { body });
  }

  plans(repoId: string, opts: { environment?: string; limit?: number } = {}): Promise<AppPlanList> {
    return this.http.request<AppPlanList>('GET', `/apps/${encodeURIComponent(repoId)}/plans`, {
      query: { environment: opts.environment, limit: opts.limit },
    });
  }

  plan(planId: string): Promise<AppPlan> {
    return this.http.request<AppPlan>('GET', `/apps/plans/${encodeURIComponent(planId)}`);
  }

  /** Build `branch` and deploy it as a preview stack (a trial deploy). */
  preview(repoId: string, branch: string): Promise<PreviewResult> {
    return this.http.request<PreviewResult>('POST', `/apps/${encodeURIComponent(repoId)}/previews`, { body: { branch } });
  }

  /** Confirm held steps of a plan by id, then apply them. A step the caller may not confirm fails the call (403). */
  confirm(planId: string, actionIds: string[]): Promise<ConfirmAppActionsResult> {
    return this.http.request<ConfirmAppActionsResult>('POST', `/apps/plans/${encodeURIComponent(planId)}/confirm`, {
      body: { action_ids: actionIds },
    });
  }

  /** Toggle "every step waits for confirmation" for an app. */
  setRequireApproval(repoId: string, require: boolean): Promise<AppRequireApproval> {
    return this.http.request<AppRequireApproval>('PUT', `/apps/${encodeURIComponent(repoId)}/require-approval`, {
      body: { require_approval: require },
    });
  }

  /** Compare each environment's last applied commit with live state (changes nothing). */
  drift(repoId: string): Promise<AppDriftList> {
    return this.http.request<AppDriftList>('GET', `/apps/${encodeURIComponent(repoId)}/drift`);
  }

  /** Opt an app in (or out) of re-applying drift on git-owned fields. */
  setEnforceDrift(repoId: string, enforce: boolean): Promise<AppEnforceDrift> {
    return this.http.request<AppEnforceDrift>('PUT', `/apps/${encodeURIComponent(repoId)}/enforce-drift`, {
      body: { enforce_drift: enforce },
    });
  }

  /**
   * Permanently delete a REMOVED managed Postgres's volumes on every node.
   * `confirm` must be exactly `<stack>/<resource>`. Irreversible.
   */
  purgeData(repoId: string, environment: string, body: { resource: string; confirm: string }): Promise<PurgeAppDataResult> {
    return this.http.request<PurgeAppDataResult>(
      'POST',
      `/apps/${encodeURIComponent(repoId)}/environments/${encodeURIComponent(environment)}/purge`,
      { body },
    );
  }

  /** Plan production with the image digests a named environment (e.g. `staging`) runs now — no rebuild, same gates. */
  promote(repoId: string, from: string): Promise<AppPromoteResult> {
    return this.http.request<AppPromoteResult>('POST', `/apps/${encodeURIComponent(repoId)}/promote`, { body: { from } });
  }
}

export class DeploymentsResource {
  constructor(private readonly http: HttpTransport) {}

  get(id: string): Promise<DeploymentStatus> {
    return this.http.request<DeploymentStatus>('GET', `/deployments/${encodeURIComponent(id)}`);
  }

  /** A deploy's progress events (poll while it runs, until `done`). */
  events(deployId: string): Promise<DeployEvents> {
    return this.http.request<DeployEvents>('GET', `/deploys/${encodeURIComponent(deployId)}/events`);
  }
}

export class StacksResource {
  constructor(private readonly http: HttpTransport) {}

  list(opts?: ListOptions): Promise<StackList> {
    return this.http.request<StackList>('GET', '/stacks', { query: listQuery(opts) });
  }

  get(id: string): Promise<Stack> {
    return this.http.request<Stack>('GET', `/stacks/${encodeURIComponent(id)}`);
  }

  /** Deploy a stack from a compose document. Async (202 Accepted). */
  deploy(body: DeployStackRequest): Promise<DeploymentRef> {
    return this.http.request<DeploymentRef>('POST', '/stacks', { body });
  }

  /**
   * Remove a stack. Its data (named volumes + its blueprint's generated
   * secrets) is kept unless `deleteData` — a same-name redeploy then picks it
   * back up.
   */
  remove(id: string, opts: { deleteData?: boolean } = {}): Promise<StackRemoved> {
    return this.http.request<StackRemoved>('DELETE', `/stacks/${encodeURIComponent(id)}`, {
      query: { delete_data: opts.deleteData ? 'true' : undefined },
    });
  }

  telemetry(id: string): Promise<StackTelemetry> {
    return this.http.request<StackTelemetry>('GET', `/stacks/${encodeURIComponent(id)}/telemetry`);
  }

  /** Error tracking for the stack: opt-in state and the Sentry-compatible DSN. */
  errors(id: string): Promise<StackErrorsStatus> {
    return this.http.request<StackErrorsStatus>('GET', `/stacks/${encodeURIComponent(id)}/errors`);
  }

  /** New DSN key; the old one stops working at once (admin). */
  rotateErrorsKey(id: string): Promise<ErrorProject> {
    return this.http.request<ErrorProject>('POST', `/stacks/${encodeURIComponent(id)}/errors/rotate-key`);
  }

  /** Turn OpenTelemetry on/off for the stack (admin). */
  setTelemetry(id: string, enabled: boolean): Promise<StackTelemetry> {
    return this.http.request<StackTelemetry>('PUT', `/stacks/${encodeURIComponent(id)}/telemetry`, { body: { enabled } });
  }

  /**
   * How to reach the app's services and managed resources from inside the
   * cluster: the DNS names swarm answers (`web`, `shop_web`, `web.shop` from
   * a connected app) and each resource's host:port.
   */
  endpoints(id: string): Promise<StackEndpoints> {
    return this.http.request<StackEndpoints>('GET', `/stacks/${encodeURIComponent(id)}/endpoints`);
  }

  /**
   * Connect two apps over one private network (both roll once to join it).
   * `id` and `peer` are a stack id or name. Idempotent; needs `write` and
   * `stack.deploy` on both apps.
   */
  connect(id: string, peer: string): Promise<StackConnection> {
    return this.http.request<StackConnection>('POST', `/stacks/${encodeURIComponent(id)}/connections`, { body: { peer } });
  }

  /** Disconnect two apps: both leave the pair network. */
  disconnect(id: string, peer: string): Promise<StackConnection> {
    return this.http.request<StackConnection>(
      'DELETE',
      `/stacks/${encodeURIComponent(id)}/connections/${encodeURIComponent(peer)}`,
    );
  }

  iterate(opts?: ListOptions): AsyncIterableIterator<Stack> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }
}

export class NodesResource {
  constructor(private readonly http: HttpTransport) {}

  list(opts?: ListOptions): Promise<NodeList> {
    return this.http.request<NodeList>('GET', '/nodes', { query: listQuery(opts) });
  }

  get(id: string): Promise<Node> {
    return this.http.request<Node>('GET', `/nodes/${encodeURIComponent(id)}`);
  }

  /** Remove a node from the swarm. */
  remove(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/nodes/${encodeURIComponent(id)}`);
  }

  /** Drain (cordon) a node: stop scheduling on it and move its tasks off. */
  drain(id: string): Promise<NodeAvailability> {
    return this.http.request<NodeAvailability>('POST', `/nodes/${encodeURIComponent(id)}/drain`);
  }

  /** Uncordon a node: restore availability `active`. */
  uncordon(id: string): Promise<NodeAvailability> {
    return this.http.request<NodeAvailability>('POST', `/nodes/${encodeURIComponent(id)}/uncordon`);
  }

  /** Replace a node's labels with `labels` (labels not named are removed). */
  setLabels(id: string, labels: Record<string, string>): Promise<NodeLabels> {
    return this.http.request<NodeLabels>('PUT', `/nodes/${encodeURIComponent(id)}/labels`, { body: { labels } });
  }

  iterate(opts?: ListOptions): AsyncIterableIterator<Node> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }
}

export class IngressResource {
  constructor(private readonly http: HttpTransport) {}

  listDomains(opts?: ListOptions): Promise<IngressDomainList> {
    return this.http.request<IngressDomainList>('GET', '/ingress/domains', { query: listQuery(opts) });
  }

  /** Add an ingress domain. Returns the created domain (201). */
  addDomain(body: AddDomainRequest): Promise<IngressDomain> {
    return this.http.request<IngressDomain>('POST', '/ingress/domains', { body });
  }

  removeDomain(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/ingress/domains/${encodeURIComponent(id)}`);
  }

  /** Change a domain's apex ↔ www pairing; `www: null` clears it. */
  updateDomain(id: string, body: UpdateDomainRequest): Promise<IngressDomain> {
    return this.http.request<IngressDomain>('PATCH', `/ingress/domains/${encodeURIComponent(id)}`, { body });
  }

  /** The domain's DNS + certificate status, with the records to set. */
  domainStatus(id: string): Promise<IngressDomainDetail> {
    return this.http.request<IngressDomainDetail>('GET', `/ingress/domains/${encodeURIComponent(id)}/status`);
  }

  /** Re-check a domain's DNS and certificate now. */
  verifyDomain(id: string): Promise<IngressDomainDetail> {
    return this.http.request<IngressDomainDetail>('POST', `/ingress/domains/${encodeURIComponent(id)}/verify`);
  }

  /** The org's edge settings (secrets read back as set / not set). */
  settings(): Promise<IngressSettings> {
    return this.http.request<IngressSettings>('GET', '/ingress/settings');
  }

  /**
   * Change the edge settings in one write (admins and owners). Fields left
   * out keep their value; `null` clears a nullable one.
   */
  updateSettings(body: UpdateIngressSettingsRequest): Promise<IngressSettings> {
    return this.http.request<IngressSettings>('PUT', '/ingress/settings', { body });
  }

  iterateDomains(opts?: ListOptions): AsyncIterableIterator<IngressDomain> {
    return paginate((cursor) => this.listDomains({ ...opts, cursor }));
  }
}

/** Join tokens: what a new server's installer presents to enroll. */
export class JoinTokensResource {
  constructor(private readonly http: HttpTransport) {}

  /** The org's join tokens, newest first (never the token itself). */
  list(): Promise<JoinTokenList> {
    return this.http.request<JoinTokenList>('GET', '/join-tokens');
  }

  /** Mint a join token (admins and owners). `token`, and `mesh` when the org runs a mesh, are returned ONCE. */
  create(body: CreateJoinTokenRequest = {}): Promise<JoinTokenIssued> {
    return this.http.request<JoinTokenIssued>('POST', '/join-tokens', { body });
  }

  /** Revoke a join token: it enrolls nothing from now on. */
  revoke(id: string): Promise<Revoked> {
    return this.http.request<Revoked>('DELETE', `/join-tokens/${encodeURIComponent(id)}`);
  }
}

/**
 * Generic cursor-pagination driver. Yields items page by page, following
 * `next_cursor` until it is null.
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ data: T[]; next_cursor: string | null }>,
): AsyncIterableIterator<T> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    for (const item of page.data) yield item;
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
}
