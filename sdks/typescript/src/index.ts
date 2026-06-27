import { HttpTransport, type SwarmyClientOptions } from './http.js';
import {
  IngressResource,
  NodesResource,
  ServicesResource,
  StacksResource,
} from './resources.js';

export * from './models.js';
export { SwarmyApiError } from './error.js';
export type { SwarmyClientOptions, FetchLike } from './http.js';
export type { ListOptions } from './resources.js';
export { paginate } from './resources.js';

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

  private readonly http: HttpTransport;

  constructor(options: SwarmyClientOptions) {
    this.http = new HttpTransport(options);
    this.services = new ServicesResource(this.http);
    this.stacks = new StacksResource(this.http);
    this.nodes = new NodesResource(this.http);
    this.ingress = new IngressResource(this.http);
  }
}

export default SwarmyClient;
