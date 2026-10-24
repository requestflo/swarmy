package swarmy

import (
	"context"
	"net/url"
	"strconv"
)

// Me returns who this credential acts as (org, user, role) and what it may do.
func (c *Client) Me(ctx context.Context) (*Principal, error) {
	var out Principal
	if err := c.do(ctx, "GET", "/me", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Notify sends an email through the org's Email service. Async (202): the
// message is queued.
func (c *Client) Notify(ctx context.Context, body NotifyBody) (*NotifyQueued, error) {
	var out NotifyQueued
	if err := c.do(ctx, "POST", "/notify", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// APIKeysService groups API key operations (/api-keys).
type APIKeysService struct{ client *Client }

// List returns the org's API keys (never the key itself).
func (s *APIKeysService) List(ctx context.Context) (*ApiKeyList, error) {
	var out ApiKeyList
	if err := s.client.do(ctx, "GET", "/api-keys", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create mints an API key (201). The plaintext Key is returned ONCE — store it.
func (s *APIKeysService) Create(ctx context.Context, body CreateApiKeyRequest) (*ApiKeyIssued, error) {
	var out ApiKeyIssued
	if err := s.client.do(ctx, "POST", "/api-keys", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Revoke revokes an API key: it authenticates nothing from now on.
func (s *APIKeysService) Revoke(ctx context.Context, id string) (*Revoked, error) {
	var out Revoked
	if err := s.client.do(ctx, "DELETE", "/api-keys/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DNSService groups authoritative DNS zone and manual record operations (/dns/*).
type DNSService struct{ client *Client }

// ListZones returns the org's DNS zones.
func (s *DNSService) ListZones(ctx context.Context) (*DnsZoneList, error) {
	var out DnsZoneList
	if err := s.client.do(ctx, "GET", "/dns/zones", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateZone creates a DNS zone.
func (s *DNSService) CreateZone(ctx context.Context, body CreateDnsZoneRequest) (*DnsZone, error) {
	var out DnsZone
	if err := s.client.do(ctx, "POST", "/dns/zones", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveZone deletes a DNS zone.
func (s *DNSService) RemoveZone(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/dns/zones/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delegation checks whether the registrar delegates the zone to swarmy's nameservers.
func (s *DNSService) Delegation(ctx context.Context, zoneID string) (*DnsDelegationCheck, error) {
	var out DnsDelegationCheck
	if err := s.client.do(ctx, "GET", "/dns/zones/"+pathEscape(zoneID)+"/delegation", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRecords returns a zone's manual records (MX/TXT/CNAME/…).
func (s *DNSService) ListRecords(ctx context.Context, zoneID string) (*DnsRecordList, error) {
	var out DnsRecordList
	if err := s.client.do(ctx, "GET", "/dns/zones/"+pathEscape(zoneID)+"/records", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpsertRecord creates or updates a manual record (matched by name + type + value).
func (s *DNSService) UpsertRecord(ctx context.Context, zoneID string, body UpsertDnsRecordRequest) (*DnsRecord, error) {
	var out DnsRecord
	if err := s.client.do(ctx, "POST", "/dns/zones/"+pathEscape(zoneID)+"/records", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveRecord deletes a manual record.
func (s *DNSService) RemoveRecord(ctx context.Context, recordID string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/dns/records/"+pathEscape(recordID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// BackupsService groups backup target and snapshot operations
// (/backup-targets, /snapshots).
type BackupsService struct{ client *Client }

// ListTargets returns the org's backup targets (restic repositories).
func (s *BackupsService) ListTargets(ctx context.Context) (*BackupTargetList, error) {
	var out BackupTargetList
	if err := s.client.do(ctx, "GET", "/backup-targets", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AddTarget adds a backup target (201).
func (s *BackupsService) AddTarget(ctx context.Context, body AddBackupTargetRequest) (*BackupTarget, error) {
	var out BackupTarget
	if err := s.client.do(ctx, "POST", "/backup-targets", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveTarget deletes a backup target.
func (s *BackupsService) RemoveTarget(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/backup-targets/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SnapshotFilter narrows BackupsService.ListSnapshots; empty fields match all.
type SnapshotFilter struct {
	Volume   string
	TargetID string
}

// ListSnapshots returns snapshots, optionally of one volume and/or target.
func (s *BackupsService) ListSnapshots(ctx context.Context, filter SnapshotFilter) (*SnapshotList, error) {
	q := url.Values{}
	if filter.Volume != "" {
		q.Set("volume", filter.Volume)
	}
	if filter.TargetID != "" {
		q.Set("target_id", filter.TargetID)
	}
	var out SnapshotList
	if err := s.client.do(ctx, "GET", "/snapshots", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// BackupVolume backs a volume up now, creating a snapshot (201).
func (s *BackupsService) BackupVolume(ctx context.Context, body BackupVolumeRequest) (*BackupRun, error) {
	var out BackupRun
	if err := s.client.do(ctx, "POST", "/snapshots", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RestoreSnapshot restores a snapshot into a volume.
func (s *BackupsService) RestoreSnapshot(ctx context.Context, body RestoreSnapshotRequest) (*RestoreResult, error) {
	var out RestoreResult
	if err := s.client.do(ctx, "POST", "/snapshots/restore", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// VolumesService groups cluster (CSI) volume operations (/volumes).
type VolumesService struct{ client *Client }

// List returns the org's cluster volumes.
func (s *VolumesService) List(ctx context.Context) (*ClusterVolumeList, error) {
	var out ClusterVolumeList
	if err := s.client.do(ctx, "GET", "/volumes", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Register registers and provisions a cluster volume (201).
func (s *VolumesService) Register(ctx context.Context, body RegisterVolumeRequest) (*ClusterVolume, error) {
	var out ClusterVolume
	if err := s.client.do(ctx, "POST", "/volumes", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Remove deregisters a cluster volume.
func (s *VolumesService) Remove(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/volumes/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AuditService groups audit log operations (/audit/*).
type AuditService struct{ client *Client }

// AuditExportOptions filters AuditService.Export; empty fields match all.
type AuditExportOptions struct {
	Actor        string // exact actor id
	ActorType    string // user | apikey | system | agent
	Action       string // action PREFIX, e.g. "secrets."
	ResourceType string
	ResourceID   string
	From         string // ISO date/datetime lower bound
	To           string // ISO date/datetime upper bound
	Format       string // csv (default) | json
}

// AuditExport is an audit log export: the raw body in the requested format.
type AuditExport struct {
	Content     []byte
	ContentType string
	// RowCount is the number of rows in Content.
	RowCount int
	// Truncated means the filter matched more than the 10 000-row cap.
	Truncated bool
}

// Export downloads the org audit log as CSV or JSON (max 10 000 rows).
func (s *AuditService) Export(ctx context.Context, opts AuditExportOptions) (*AuditExport, error) {
	q := url.Values{}
	for k, v := range map[string]string{
		"actor": opts.Actor, "actor_type": opts.ActorType, "action": opts.Action,
		"resource_type": opts.ResourceType, "resource_id": opts.ResourceID,
		"from": opts.From, "to": opts.To, "format": opts.Format,
	} {
		if v != "" {
			q.Set(k, v)
		}
	}
	data, header, err := s.client.doRaw(ctx, "GET", "/audit/export", q, nil)
	if err != nil {
		return nil, err
	}
	rows, _ := strconv.Atoi(header.Get("X-Swarmy-Row-Count"))
	return &AuditExport{
		Content:     data,
		ContentType: header.Get("Content-Type"),
		RowCount:    rows,
		Truncated:   header.Get("X-Swarmy-Truncated") == "true",
	}, nil
}

// RegistryCredentialsService groups private registry login operations
// (/registry-credentials). Secrets are write-only.
type RegistryCredentialsService struct{ client *Client }

// List returns the org's registry credentials (secrets never returned).
func (s *RegistryCredentialsService) List(ctx context.Context) (*RegistryCredentialList, error) {
	var out RegistryCredentialList
	if err := s.client.do(ctx, "GET", "/registry-credentials", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create stores a registry credential, or rotates the login for an existing
// prefix (201).
func (s *RegistryCredentialsService) Create(ctx context.Context, body CreateRegistryCredentialBody) (*RegistryCredential, error) {
	var out RegistryCredential
	if err := s.client.do(ctx, "POST", "/registry-credentials", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update changes a credential's username or label, or rotates its secret.
// Fields left unset keep their value.
func (s *RegistryCredentialsService) Update(ctx context.Context, id string, body UpdateRegistryCredentialBody) (*RegistryCredential, error) {
	var out RegistryCredential
	if err := s.client.do(ctx, "PATCH", "/registry-credentials/"+pathEscape(id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Remove deletes a registry credential.
func (s *RegistryCredentialsService) Remove(ctx context.Context, id string) (*RegistryCredentialDeleted, error) {
	var out RegistryCredentialDeleted
	if err := s.client.do(ctx, "DELETE", "/registry-credentials/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Test checks a stored credential against its registry (v2 auth, and a
// manifest HEAD when body.Image is set).
func (s *RegistryCredentialsService) Test(ctx context.Context, id string, body TestRegistryCredentialBody) (*RegistryTestResult, error) {
	var out RegistryTestResult
	if err := s.client.do(ctx, "POST", "/registry-credentials/"+pathEscape(id)+"/test", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeploymentsService reads the async work a 202 started (/deployments, /deploys).
type DeploymentsService struct{ client *Client }

// Get returns a deployment's convergence; poll it until a terminal phase.
// id is the DeploymentRef.DeploymentID a create/update/scale/restart returned.
func (s *DeploymentsService) Get(ctx context.Context, id string) (*DeploymentStatus, error) {
	var out DeploymentStatus
	if err := s.client.do(ctx, "GET", "/deployments/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Events returns a stack deploy's progress events; poll while Done is false.
func (s *DeploymentsService) Events(ctx context.Context, deployID string) (*DeployEvents, error) {
	var out DeployEvents
	if err := s.client.do(ctx, "GET", "/deploys/"+pathEscape(deployID)+"/events", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
