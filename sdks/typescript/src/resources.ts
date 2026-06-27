import type { HttpTransport } from './http.js';
import type {
  AddDomainRequest,
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
