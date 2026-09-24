import { HttpTransport, type SwarmyClientOptions } from './http.js';
import type { Principal } from './models.js';
import {
  AppsResource,
  DeploymentsResource,
  IngressResource,
  NodesResource,
  ServicesResource,
  StacksResource,
} from './resources.js';

export * from './models.js';
export { SwarmyApiError } from './error.js';
export { SwarmyEmail, SwarmyEmailError } from './email.js';
export type { SendEmailInput, SendEmailResult, SwarmyEmailOptions } from './email.js';
export type { SwarmyClientOptions, FetchLike } from './http.js';
export type { ListOptions } from './resources.js';
export { paginate, sseData } from './resources.js';

/**
 * Official client for the swarmy public REST API.
 *
 * ```ts
 * const swarmy = new SwarmyClient({ endpoint: 'https://swarm.example.com', apiKey: 'swk_…' });
 * const { data } = await swarmy.services.list();
 * for await (const svc of swarmy.services.iterate()) console.log(svc.name);
 * ```
 */
export class SwarmyClient {
  readonly services: ServicesResource;
  readonly stacks: StacksResource;
  readonly nodes: NodesResource;
  readonly ingress: IngressResource;
  readonly apps: AppsResource;
  readonly deployments: DeploymentsResource;

  private readonly http: HttpTransport;

  constructor(options: SwarmyClientOptions) {
    this.http = new HttpTransport(options);
    this.services = new ServicesResource(this.http);
    this.stacks = new StacksResource(this.http);
    this.nodes = new NodesResource(this.http);
    this.ingress = new IngressResource(this.http);
    this.apps = new AppsResource(this.http);
    this.deployments = new DeploymentsResource(this.http);
  }

  /** Who this credential acts as (org, user, role) and its scopes. */
  me(): Promise<Principal> {
    return this.http.request<Principal>('GET', '/me');
  }
}

export default SwarmyClient;
