import type { HttpTransport } from './http.js';
import type {
  AddDomainRequest,
  App,
  AppDeployResult,
  AppList,
  AppPlan,
  AppPlanList,
  DeploymentStatus,
  LogLine,
  LogLineList,
  PatchServiceEnvResult,
  ErrorProject,
  PreviewResult,
  StackErrorsStatus,
  Principal,
  ServiceEnv,
  StackTelemetry,
  CreateServiceRequest,
  DeployStackRequest,
  DeploymentRef,
  IngressDomain,
  IngressDomainList,
  Node,
  NodeList,
  Removed,
  Service,
  ServiceList,
  Stack,
  StackList,
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
}

export class DeploymentsResource {
  constructor(private readonly http: HttpTransport) {}

  get(id: string): Promise<DeploymentStatus> {
    return this.http.request<DeploymentStatus>('GET', `/deployments/${encodeURIComponent(id)}`);
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

  remove(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/stacks/${encodeURIComponent(id)}`);
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

  iterateDomains(opts?: ListOptions): AsyncIterableIterator<IngressDomain> {
    return paginate((cursor) => this.listDomains({ ...opts, cursor }));
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
