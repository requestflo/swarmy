import { HttpTransport, type SwarmyClientOptions } from './http.js';
import type { NotifyBody, NotifyQueued, Principal } from './models.js';
import {
  AppsResource,
  DeploymentsResource,
  IngressResource,
  JoinTokensResource,
  NodesResource,
  ServicesResource,
  StacksResource,
} from './resources.js';
import {
  ApiKeysResource,
  AuditResource,
  BackupsResource,
  DnsResource,
  GitResource,
  RegistryCredentialsResource,
  VolumesResource,
} from './resources-extra.js';

export * from './models.js';
export { SwarmyApiError } from './error.js';
export { SwarmyEmail, SwarmyEmailError } from './email.js';
export type { SendEmailInput, SendEmailResult, SwarmyEmailOptions } from './email.js';
export type { SwarmyClientOptions, FetchLike } from './http.js';
export type { ListOptions } from './resources.js';
export type { AuditExport, AuditExportOptions } from './resources-extra.js';
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
  readonly joinTokens: JoinTokensResource;
  readonly apiKeys: ApiKeysResource;
  readonly dns: DnsResource;
  readonly backups: BackupsResource;
  readonly volumes: VolumesResource;
  readonly audit: AuditResource;
  readonly registryCredentials: RegistryCredentialsResource;
  readonly git: GitResource;

  private readonly http: HttpTransport;

  constructor(options: SwarmyClientOptions) {
    this.http = new HttpTransport(options);
    this.services = new ServicesResource(this.http);
    this.stacks = new StacksResource(this.http);
    this.nodes = new NodesResource(this.http);
    this.ingress = new IngressResource(this.http);
    this.apps = new AppsResource(this.http);
    this.deployments = new DeploymentsResource(this.http);
    this.joinTokens = new JoinTokensResource(this.http);
    this.apiKeys = new ApiKeysResource(this.http);
    this.dns = new DnsResource(this.http);
    this.backups = new BackupsResource(this.http);
    this.volumes = new VolumesResource(this.http);
    this.audit = new AuditResource(this.http);
    this.registryCredentials = new RegistryCredentialsResource(this.http);
    this.git = new GitResource(this.http);
  }

  /** Who this credential acts as (org, user, role) and its scopes. */
  me(): Promise<Principal> {
    return this.http.request<Principal>('GET', '/me');
  }

  /** Send an email through the org's Email service (202, queued). */
  notify(body: NotifyBody): Promise<NotifyQueued> {
    return this.http.request<NotifyQueued>('POST', '/notify', { body });
  }
}

export default SwarmyClient;
