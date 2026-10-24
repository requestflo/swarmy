import type { HttpTransport } from './http.js';
import type {
  AddBackupTargetRequest,
  ApiKeyIssued,
  ApiKeyList,
  BackupRun,
  BackupTarget,
  BackupTargetList,
  BackupVolumeRequest,
  ClusterVolume,
  ClusterVolumeList,
  CreateApiKeyRequest,
  CreateDnsZoneRequest,
  CreateGitConnectionBody,
  CreateRegistryCredentialBody,
  DnsDelegationCheck,
  DnsRecord,
  DnsRecordList,
  DnsZone,
  DnsZoneList,
  GitConnection,
  GitConnectionList,
  GitProviderBranchList,
  GitProviderRepoList,
  GitRemoved,
  GitRepo,
  GitRepoList,
  LinkedGitRepo,
  LinkGitRepoBody,
  RegisterVolumeRequest,
  RegistryCredential,
  RegistryCredentialDeleted,
  RegistryCredentialList,
  RegistryTestResult,
  Removed,
  RestoreResult,
  RestoreSnapshotRequest,
  Revoked,
  SnapshotList,
  TestRegistryCredentialBody,
  UpdateGitRepoBody,
  UpdateRegistryCredentialBody,
  UpsertDnsRecordRequest,
} from './models.js';

/** API keys (`swk_…`): list, mint and revoke the org's programmatic credentials. */
export class ApiKeysResource {
  constructor(private readonly http: HttpTransport) {}

  /** The org's API keys (never the key itself). */
  list(): Promise<ApiKeyList> {
    return this.http.request<ApiKeyList>('GET', '/api-keys');
  }

  /** Mint a key (201). Its plaintext `key` is returned ONCE — store it. */
  create(body: CreateApiKeyRequest): Promise<ApiKeyIssued> {
    return this.http.request<ApiKeyIssued>('POST', '/api-keys', { body });
  }

  /** Revoke a key: it authenticates nothing from now on. */
  revoke(id: string): Promise<Revoked> {
    return this.http.request<Revoked>('DELETE', `/api-keys/${encodeURIComponent(id)}`);
  }
}

/** Authoritative DNS: zones swarmy serves and their manual records. */
export class DnsResource {
  constructor(private readonly http: HttpTransport) {}

  listZones(): Promise<DnsZoneList> {
    return this.http.request<DnsZoneList>('GET', '/dns/zones');
  }

  createZone(body: CreateDnsZoneRequest): Promise<DnsZone> {
    return this.http.request<DnsZone>('POST', '/dns/zones', { body });
  }

  removeZone(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/dns/zones/${encodeURIComponent(id)}`);
  }

  /** Whether the registrar delegates the zone to swarmy's nameservers. */
  delegation(zoneId: string): Promise<DnsDelegationCheck> {
    return this.http.request<DnsDelegationCheck>('GET', `/dns/zones/${encodeURIComponent(zoneId)}/delegation`);
  }

  /** The zone's manual records (MX/TXT/CNAME/…). */
  listRecords(zoneId: string): Promise<DnsRecordList> {
    return this.http.request<DnsRecordList>('GET', `/dns/zones/${encodeURIComponent(zoneId)}/records`);
  }

  /** Create or update a manual record (upsert by name + type + value). */
  upsertRecord(zoneId: string, body: UpsertDnsRecordRequest): Promise<DnsRecord> {
    return this.http.request<DnsRecord>('POST', `/dns/zones/${encodeURIComponent(zoneId)}/records`, { body });
  }

  removeRecord(recordId: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/dns/records/${encodeURIComponent(recordId)}`);
  }
}

/** Volume backups: restic targets, snapshots, backup-now and restore. */
export class BackupsResource {
  constructor(private readonly http: HttpTransport) {}

  listTargets(): Promise<BackupTargetList> {
    return this.http.request<BackupTargetList>('GET', '/backup-targets');
  }

  /** Add a backup target (a restic repository) (201). */
  addTarget(body: AddBackupTargetRequest): Promise<BackupTarget> {
    return this.http.request<BackupTarget>('POST', '/backup-targets', { body });
  }

  removeTarget(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/backup-targets/${encodeURIComponent(id)}`);
  }

  /** Snapshots, optionally of one volume and/or in one target. */
  listSnapshots(opts: { volume?: string; targetId?: string } = {}): Promise<SnapshotList> {
    return this.http.request<SnapshotList>('GET', '/snapshots', {
      query: { volume: opts.volume, target_id: opts.targetId },
    });
  }

  /** Back up a volume now: creates a snapshot (201). */
  backupVolume(body: BackupVolumeRequest): Promise<BackupRun> {
    return this.http.request<BackupRun>('POST', '/snapshots', { body });
  }

  /** Restore a snapshot into a volume (its own by default). */
  restoreSnapshot(body: RestoreSnapshotRequest): Promise<RestoreResult> {
    return this.http.request<RestoreResult>('POST', '/snapshots/restore', { body });
  }
}

/** Cluster (CSI) volumes. */
export class VolumesResource {
  constructor(private readonly http: HttpTransport) {}

  list(): Promise<ClusterVolumeList> {
    return this.http.request<ClusterVolumeList>('GET', '/volumes');
  }

  /** Register and provision a cluster volume (201). */
  register(body: RegisterVolumeRequest): Promise<ClusterVolume> {
    return this.http.request<ClusterVolume>('POST', '/volumes', { body });
  }

  /** Deregister a cluster volume. */
  remove(id: string): Promise<Removed> {
    return this.http.request<Removed>('DELETE', `/volumes/${encodeURIComponent(id)}`);
  }
}

/** Filters for {@link AuditResource.export}; all optional. */
export interface AuditExportOptions {
  /** Exact actor id. */
  actor?: string;
  actorType?: 'user' | 'apikey' | 'system' | 'agent';
  /** Action PREFIX, e.g. `secrets.`. */
  action?: string;
  resourceType?: string;
  resourceId?: string;
  /** ISO date/datetime lower bound. */
  from?: string;
  /** ISO date/datetime upper bound. */
  to?: string;
  /** Default `csv`. */
  format?: 'csv' | 'json';
}

/** The audit export body as the server sent it, plus its row-count headers. */
export interface AuditExport {
  /** The CSV text, or the JSON array text when `format: 'json'`. */
  content: string;
  contentType: string;
  /** `X-Swarmy-Row-Count`. */
  rowCount: number;
  /** `X-Swarmy-Truncated`: the filter matched more than the 10 000-row cap. */
  truncated: boolean;
}

/** The org audit log. */
export class AuditResource {
  constructor(private readonly http: HttpTransport) {}

  /** Export the filtered audit log as CSV (default) or JSON, max 10 000 rows. */
  async export(opts: AuditExportOptions = {}): Promise<AuditExport> {
    const res = await this.http.raw('GET', '/audit/export', {
      query: {
        actor: opts.actor,
        actor_type: opts.actorType,
        action: opts.action,
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
        from: opts.from,
        to: opts.to,
        format: opts.format,
      },
      accept: 'text/csv, application/json, application/problem+json',
    });
    return {
      content: await res.text(),
      contentType: res.headers.get('content-type') ?? '',
      rowCount: Number(res.headers.get('x-swarmy-row-count') ?? 0),
      truncated: res.headers.get('x-swarmy-truncated') === 'true',
    };
  }
}

/** Private-registry logins swarmy pulls with (secrets are never returned). */
export class RegistryCredentialsResource {
  constructor(private readonly http: HttpTransport) {}

  list(): Promise<RegistryCredentialList> {
    return this.http.request<RegistryCredentialList>('GET', '/registry-credentials');
  }

  /** Create a credential, or rotate the login for an existing prefix (201). */
  create(body: CreateRegistryCredentialBody): Promise<RegistryCredential> {
    return this.http.request<RegistryCredential>('POST', '/registry-credentials', { body });
  }

  /** Change the username/label, or rotate the secret. `label: null` clears the label. */
  update(id: string, body: UpdateRegistryCredentialBody): Promise<RegistryCredential> {
    return this.http.request<RegistryCredential>('PATCH', `/registry-credentials/${encodeURIComponent(id)}`, { body });
  }

  remove(id: string): Promise<RegistryCredentialDeleted> {
    return this.http.request<RegistryCredentialDeleted>('DELETE', `/registry-credentials/${encodeURIComponent(id)}`);
  }

  /** Test a stored credential (registry v2 auth; a manifest HEAD when `image` is given). */
  test(id: string, body: TestRegistryCredentialBody = {}): Promise<RegistryTestResult> {
    return this.http.request<RegistryTestResult>('POST', `/registry-credentials/${encodeURIComponent(id)}/test`, { body });
  }
}

/**
 * Git provider connections and linked repositories (`/git/*`). Only
 * token-based connections (GitLab token, Gitea, generic) can be created over
 * the API; GitHub App and GitLab OAuth need the dashboard.
 */
export class GitResource {
  constructor(private readonly http: HttpTransport) {}

  /** The org's git provider connections (no credentials). */
  listConnections(): Promise<GitConnectionList> {
    return this.http.request<GitConnectionList>('GET', '/git/connections');
  }

  getConnection(id: string): Promise<GitConnection> {
    return this.http.request<GitConnection>('GET', `/git/connections/${encodeURIComponent(id)}`);
  }

  /** Connect a GitLab (token), Gitea or generic git host (201). */
  createConnection(body: CreateGitConnectionBody): Promise<GitConnection> {
    return this.http.request<GitConnection>('POST', '/git/connections', { body });
  }

  removeConnection(id: string): Promise<GitRemoved> {
    return this.http.request<GitRemoved>('DELETE', `/git/connections/${encodeURIComponent(id)}`);
  }

  /** Repositories the connection can see (optional search). */
  listProviderRepos(connectionId: string, opts: { search?: string } = {}): Promise<GitProviderRepoList> {
    return this.http.request<GitProviderRepoList>('GET', `/git/connections/${encodeURIComponent(connectionId)}/repos`, {
      query: { search: opts.search },
    });
  }

  /** Branches of a provider repo (`owner/name`) visible to the connection. */
  listProviderBranches(connectionId: string, repo: string): Promise<GitProviderBranchList> {
    return this.http.request<GitProviderBranchList>(
      'GET',
      `/git/connections/${encodeURIComponent(connectionId)}/branches`,
      { query: { repo } },
    );
  }

  /** The org's linked repositories (no secrets). */
  listRepos(): Promise<GitRepoList> {
    return this.http.request<GitRepoList>('GET', '/git/repos');
  }

  getRepo(id: string): Promise<GitRepo> {
    return this.http.request<GitRepo>('GET', `/git/repos/${encodeURIComponent(id)}`);
  }

  /** Link a repository (201). The webhook secret and deploy-key public half are returned ONCE. */
  linkRepo(body: LinkGitRepoBody): Promise<LinkedGitRepo> {
    return this.http.request<LinkedGitRepo>('POST', '/git/repos', { body });
  }

  /** Change a linked repository's branch and/or swarmy.yaml path in place. */
  updateRepo(id: string, body: UpdateGitRepoBody): Promise<GitRepo> {
    return this.http.request<GitRepo>('PATCH', `/git/repos/${encodeURIComponent(id)}`, { body });
  }

  /** Unlink a repository. */
  removeRepo(id: string): Promise<GitRemoved> {
    return this.http.request<GitRemoved>('DELETE', `/git/repos/${encodeURIComponent(id)}`);
  }
}
