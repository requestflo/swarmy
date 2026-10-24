package swarmy

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/url"
	"strconv"
	"strings"
)

// ServicesService groups service operations.
type ServicesService struct{ client *Client }

// List returns a page of services.
func (s *ServicesService) List(ctx context.Context, cursor string, limit int) (*ServiceList, error) {
	var out ServiceList
	if err := s.client.do(ctx, "GET", "/services", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns a single service.
func (s *ServicesService) Get(ctx context.Context, id string) (*Service, error) {
	var out Service
	if err := s.client.do(ctx, "GET", "/services/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create creates a service. Returns a deployment reference (async, 202).
func (s *ServicesService) Create(ctx context.Context, body CreateServiceRequest) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/services", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Scale scales a service. Async (202).
func (s *ServicesService) Scale(ctx context.Context, id string, replicas int) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/services/"+pathEscape(id)+"/scale", nil, ScaleServiceRequest{Replicas: replicas}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update changes a running service: only the fields set in body change, the
// rest keep their live values. Async (202). It runs the same admission checks
// as a deploy, so a guardrail can refuse it (412, APIError with
// swarmy_code POLICY_DENIED).
func (s *ServicesService) Update(ctx context.Context, id string, body UpdateServiceRequest) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "PATCH", "/services/"+pathEscape(id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Restart restarts a service. Async (202).
func (s *ServicesService) Restart(ctx context.Context, id string) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/services/"+pathEscape(id)+"/restart", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Remove deletes a service.
func (s *ServicesService) Remove(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/services/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Env returns a service's environment. Secret values are nil unless
// revealSecrets is set AND the key holds the secrets.read scope AND policy
// permits it (each reveal is audited).
func (s *ServicesService) Env(ctx context.Context, id string, revealSecrets bool) (*ServiceEnv, error) {
	var q url.Values
	if revealSecrets {
		q = url.Values{"reveal_secrets": {"true"}}
	}
	var out ServiceEnv
	if err := s.client.do(ctx, "GET", "/services/"+pathEscape(id)+"/env", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PatchEnv merge-patches a service's environment: keys not named are kept.
// Async rollout (202).
func (s *ServicesService) PatchEnv(ctx context.Context, id string, body PatchServiceEnvBody) (*PatchServiceEnvResult, error) {
	var out PatchServiceEnvResult
	if err := s.client.do(ctx, "PATCH", "/services/"+pathEscape(id)+"/env", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// LogOptions tunes ServicesService.Logs and FollowLogs. Zero values use the
// server defaults.
type LogOptions struct {
	// Tail is how many of the last lines to return.
	Tail int
	// Since only returns lines from this unix timestamp on.
	Since int
}

func (o LogOptions) values() url.Values {
	q := url.Values{}
	if o.Tail > 0 {
		q.Set("tail", strconv.Itoa(o.Tail))
	}
	if o.Since > 0 {
		q.Set("since", strconv.Itoa(o.Since))
	}
	return q
}

// Logs returns the last lines of a service's logs, all tasks, oldest first.
func (s *ServicesService) Logs(ctx context.Context, id string, opts LogOptions) (*LogLineList, error) {
	var out LogLineList
	if err := s.client.do(ctx, "GET", "/services/"+pathEscape(id)+"/logs", opts.values(), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// FollowLogs follows a service's logs (Server-Sent Events), calling fn for
// each line. It returns nil when the server ends the stream, fn's error when
// fn fails, and ctx.Err() once ctx is cancelled. A malformed event is skipped.
func (s *ServicesService) FollowLogs(ctx context.Context, id string, opts LogOptions, fn func(LogLine) error) error {
	resp, err := s.client.stream(ctx, "GET", "/services/"+pathEscape(id)+"/logs/stream", opts.values())
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var fnErr error
	readErr := readSSE(resp.Body, func(data string) error {
		var line LogLine
		if json.Unmarshal([]byte(data), &line) != nil {
			return nil
		}
		fnErr = fn(line)
		return fnErr
	})
	if fnErr != nil {
		return fnErr
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return readErr
}

// readSSE reads a Server-Sent Events body, calling fn with each event's
// `data:` payload (multi-line data joined by "\n"). It returns nil at EOF,
// fn's first error, or the read error.
func readSSE(body io.Reader, fn func(data string) error) error {
	r := bufio.NewReader(body)
	var data []string
	flush := func() error {
		if len(data) == 0 {
			return nil
		}
		payload := strings.Join(data, "\n")
		data = data[:0]
		return fn(payload)
	}
	for {
		line, err := r.ReadString('\n')
		if len(line) > 0 || err == nil {
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if ferr := flush(); ferr != nil {
					return ferr
				}
			case strings.HasPrefix(line, "data:"):
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		if err == io.EOF {
			return flush()
		}
		if err != nil {
			return err
		}
	}
}

// Iterate calls fn for every service across all pages, following next_cursor.
func (s *ServicesService) Iterate(ctx context.Context, limit int, fn func(Service) error) error {
	cursor := ""
	for {
		page, err := s.List(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// StacksService groups stack operations.
type StacksService struct{ client *Client }

// List returns a page of stacks.
func (s *StacksService) List(ctx context.Context, cursor string, limit int) (*StackList, error) {
	var out StackList
	if err := s.client.do(ctx, "GET", "/stacks", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns a single stack.
func (s *StacksService) Get(ctx context.Context, id string) (*Stack, error) {
	var out Stack
	if err := s.client.do(ctx, "GET", "/stacks/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Deploy deploys a stack from a compose document. Async (202).
func (s *StacksService) Deploy(ctx context.Context, body DeployStackRequest) (*DeploymentRef, error) {
	var out DeploymentRef
	if err := s.client.do(ctx, "POST", "/stacks", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveStackOptions tunes StacksService.Remove.
type RemoveStackOptions struct {
	// DeleteData also deletes the stack's data: its named volumes on every
	// server and the secrets its blueprint generated. Default: kept, so a
	// same-name redeploy picks the old data back up.
	DeleteData bool
}

// Remove deletes a stack (its data is kept unless opts.DeleteData).
func (s *StacksService) Remove(ctx context.Context, id string, opts RemoveStackOptions) (*StackRemoved, error) {
	var out StackRemoved
	var q url.Values
	if opts.DeleteData {
		q = url.Values{"delete_data": {"true"}}
	}
	if err := s.client.do(ctx, "DELETE", "/stacks/"+pathEscape(id), q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Endpoints says how to reach the app's services and managed resources from
// inside the cluster: the DNS names swarm answers and each resource's host:port.
func (s *StacksService) Endpoints(ctx context.Context, id string) (*StackEndpoints, error) {
	var out StackEndpoints
	if err := s.client.do(ctx, "GET", "/stacks/"+pathEscape(id)+"/endpoints", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Connect connects two apps over one private network (both roll once to join
// it). id and peer are a stack id or name. Idempotent.
func (s *StacksService) Connect(ctx context.Context, id, peer string) (*StackConnection, error) {
	var out StackConnection
	if err := s.client.do(ctx, "POST", "/stacks/"+pathEscape(id)+"/connections", nil, ConnectStackRequest{Peer: peer}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Disconnect disconnects two apps: both leave the pair network.
func (s *StacksService) Disconnect(ctx context.Context, id, peer string) (*StackConnection, error) {
	var out StackConnection
	if err := s.client.do(ctx, "DELETE", "/stacks/"+pathEscape(id)+"/connections/"+pathEscape(peer), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Telemetry says whether OpenTelemetry is on for a stack.
func (s *StacksService) Telemetry(ctx context.Context, id string) (*StackTelemetry, error) {
	var out StackTelemetry
	if err := s.client.do(ctx, "GET", "/stacks/"+pathEscape(id)+"/telemetry", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetTelemetry turns OpenTelemetry on or off for a stack (admins and owners).
func (s *StacksService) SetTelemetry(ctx context.Context, id string, enabled bool) (*StackTelemetry, error) {
	var out StackTelemetry
	if err := s.client.do(ctx, "PUT", "/stacks/"+pathEscape(id)+"/telemetry", nil, SetStackTelemetryBody{Enabled: enabled}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Errors returns error tracking for a stack: its opt-in state and the
// Sentry-compatible DSN.
func (s *StacksService) Errors(ctx context.Context, id string) (*StackErrorsStatus, error) {
	var out StackErrorsStatus
	if err := s.client.do(ctx, "GET", "/stacks/"+pathEscape(id)+"/errors", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RotateErrorsKey issues a new DSN key for the stack; the old one stops
// working at once (admins and owners).
func (s *StacksService) RotateErrorsKey(ctx context.Context, id string) (*ErrorProject, error) {
	var out ErrorProject
	if err := s.client.do(ctx, "POST", "/stacks/"+pathEscape(id)+"/errors/rotate-key", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate calls fn for every stack across all pages.
func (s *StacksService) Iterate(ctx context.Context, limit int, fn func(Stack) error) error {
	cursor := ""
	for {
		page, err := s.List(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// NodesService groups node operations.
type NodesService struct{ client *Client }

// List returns a page of nodes.
func (s *NodesService) List(ctx context.Context, cursor string, limit int) (*NodeList, error) {
	var out NodeList
	if err := s.client.do(ctx, "GET", "/nodes", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns a single node.
func (s *NodesService) Get(ctx context.Context, id string) (*Node, error) {
	var out Node
	if err := s.client.do(ctx, "GET", "/nodes/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Remove removes a node from the swarm.
func (s *NodesService) Remove(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/nodes/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Drain drains (cordons) a node: nothing new is scheduled on it and its tasks
// move off.
func (s *NodesService) Drain(ctx context.Context, id string) (*NodeAvailability, error) {
	var out NodeAvailability
	if err := s.client.do(ctx, "POST", "/nodes/"+pathEscape(id)+"/drain", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Uncordon restores a node's availability to active.
func (s *NodesService) Uncordon(ctx context.Context, id string) (*NodeAvailability, error) {
	var out NodeAvailability
	if err := s.client.do(ctx, "POST", "/nodes/"+pathEscape(id)+"/uncordon", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetLabels replaces a node's labels with labels.
func (s *NodesService) SetLabels(ctx context.Context, id string, labels map[string]string) (*NodeLabels, error) {
	var out NodeLabels
	if err := s.client.do(ctx, "PUT", "/nodes/"+pathEscape(id)+"/labels", nil, SetNodeLabelsRequest{Labels: labels}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Iterate calls fn for every node across all pages.
func (s *NodesService) Iterate(ctx context.Context, limit int, fn func(Node) error) error {
	cursor := ""
	for {
		page, err := s.List(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// IngressService groups ingress-domain operations.
type IngressService struct{ client *Client }

// ListDomains returns a page of ingress domains.
func (s *IngressService) ListDomains(ctx context.Context, cursor string, limit int) (*IngressDomainList, error) {
	var out IngressDomainList
	if err := s.client.do(ctx, "GET", "/ingress/domains", listValues(cursor, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AddDomain adds an ingress domain (201).
func (s *IngressService) AddDomain(ctx context.Context, body AddDomainRequest) (*IngressDomain, error) {
	var out IngressDomain
	if err := s.client.do(ctx, "POST", "/ingress/domains", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveDomain deletes an ingress domain.
func (s *IngressService) RemoveDomain(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/ingress/domains/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateDomain changes a domain's apex ↔ www pairing (a nil Www clears it).
func (s *IngressService) UpdateDomain(ctx context.Context, id string, body UpdateDomainRequest) (*IngressDomain, error) {
	var out IngressDomain
	if err := s.client.do(ctx, "PATCH", "/ingress/domains/"+pathEscape(id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DomainStatus returns a domain's DNS + certificate status and the records
// to set.
func (s *IngressService) DomainStatus(ctx context.Context, id string) (*IngressDomainDetail, error) {
	var out IngressDomainDetail
	if err := s.client.do(ctx, "GET", "/ingress/domains/"+pathEscape(id)+"/status", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// VerifyDomain re-checks a domain now and returns its status.
func (s *IngressService) VerifyDomain(ctx context.Context, id string) (*IngressDomainDetail, error) {
	var out IngressDomainDetail
	if err := s.client.do(ctx, "POST", "/ingress/domains/"+pathEscape(id)+"/verify", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Settings reads the org's ingress settings: driver, topology, image, target
// nodes, TLS, tunnel and DNS provider. Secrets read back as set / not set.
func (s *IngressService) Settings(ctx context.Context) (*IngressSettings, error) {
	var out IngressSettings
	if err := s.client.do(ctx, "GET", "/ingress/settings", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateSettings changes the ingress settings in one write (admins and
// owners; the edge converges once). Fields left unset keep their value; a
// Nullable set to Null clears it. Returns the settings after the change.
func (s *IngressService) UpdateSettings(ctx context.Context, body UpdateIngressSettingsRequest) (*IngressSettings, error) {
	var out IngressSettings
	if err := s.client.do(ctx, "PUT", "/ingress/settings", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IterateDomains calls fn for every ingress domain across all pages.
func (s *IngressService) IterateDomains(ctx context.Context, limit int, fn func(IngressDomain) error) error {
	cursor := ""
	for {
		page, err := s.ListDomains(ctx, cursor, limit)
		if err != nil {
			return err
		}
		for _, item := range page.Data {
			if err := fn(item); err != nil {
				return err
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// JoinTokensService groups join-token operations (/join-tokens): the token a
// new server's installer presents to enroll.
type JoinTokensService struct{ client *Client }

// List returns the org's join tokens, newest first (never the token itself).
func (s *JoinTokensService) List(ctx context.Context) (*JoinTokenList, error) {
	var out JoinTokenList
	if err := s.client.do(ctx, "GET", "/join-tokens", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create mints a join token (admins and owners; 201). The plaintext Token, and
// Mesh when the org runs a mesh, are returned ONCE — store them.
func (s *JoinTokensService) Create(ctx context.Context, body CreateJoinTokenRequest) (*JoinTokenIssued, error) {
	var out JoinTokenIssued
	if err := s.client.do(ctx, "POST", "/join-tokens", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Revoke revokes a join token: it enrolls nothing from now on.
func (s *JoinTokensService) Revoke(ctx context.Context, id string) (*Revoked, error) {
	var out Revoked
	if err := s.client.do(ctx, "DELETE", "/join-tokens/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GitService groups git provider connection + linked-repo operations
// (/git/*). Only token-based connections (GitLab token, Gitea, generic) can be
// created over the API; GitHub App and GitLab OAuth need the dashboard.
type GitService struct{ client *Client }

// ListConnections returns the org's git provider connections (no credentials).
func (s *GitService) ListConnections(ctx context.Context) (*GitConnectionList, error) {
	var out GitConnectionList
	if err := s.client.do(ctx, "GET", "/git/connections", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetConnection returns a single git connection.
func (s *GitService) GetConnection(ctx context.Context, id string) (*GitConnection, error) {
	var out GitConnection
	if err := s.client.do(ctx, "GET", "/git/connections/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateConnection connects a GitLab (token), Gitea or generic git host (201).
func (s *GitService) CreateConnection(ctx context.Context, body CreateGitConnectionBody) (*GitConnection, error) {
	var out GitConnection
	if err := s.client.do(ctx, "POST", "/git/connections", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveConnection deletes a git connection.
func (s *GitService) RemoveConnection(ctx context.Context, id string) (*GitRemoved, error) {
	var out GitRemoved
	if err := s.client.do(ctx, "DELETE", "/git/connections/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListProviderRepos lists repositories the connection can see (optional search).
func (s *GitService) ListProviderRepos(ctx context.Context, connectionID, search string) (*GitProviderRepoList, error) {
	q := url.Values{}
	if search != "" {
		q.Set("search", search)
	}
	var out GitProviderRepoList
	if err := s.client.do(ctx, "GET", "/git/connections/"+pathEscape(connectionID)+"/repos", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListProviderBranches lists branches of a provider repo visible to the connection.
func (s *GitService) ListProviderBranches(ctx context.Context, connectionID, repo string) (*GitProviderBranchList, error) {
	q := url.Values{"repo": []string{repo}}
	var out GitProviderBranchList
	if err := s.client.do(ctx, "GET", "/git/connections/"+pathEscape(connectionID)+"/branches", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRepos returns the org's linked repositories.
func (s *GitService) ListRepos(ctx context.Context) (*GitRepoList, error) {
	var out GitRepoList
	if err := s.client.do(ctx, "GET", "/git/repos", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetRepo returns a single linked repository.
func (s *GitService) GetRepo(ctx context.Context, id string) (*GitRepo, error) {
	var out GitRepo
	if err := s.client.do(ctx, "GET", "/git/repos/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// LinkRepo links a repository (201). The webhook secret and deploy-key public
// half in the response are returned ONCE — store them.
func (s *GitService) LinkRepo(ctx context.Context, body LinkGitRepoBody) (*LinkedGitRepo, error) {
	var out LinkedGitRepo
	if err := s.client.do(ctx, "POST", "/git/repos", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RemoveRepo unlinks a repository.
func (s *GitService) RemoveRepo(ctx context.Context, id string) (*GitRemoved, error) {
	var out GitRemoved
	if err := s.client.do(ctx, "DELETE", "/git/repos/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateRepo changes a linked repository's branch and/or swarmy.yaml path in place.
func (s *GitService) UpdateRepo(ctx context.Context, id string, body UpdateGitRepoBody) (*GitRepo, error) {
	var out GitRepo
	if err := s.client.do(ctx, "PATCH", "/git/repos/"+pathEscape(id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AppsService groups GitOps app operations (/apps/*): plans per environment,
// confirming held steps, the require-approval toggle, deploy-now and drift.
type AppsService struct{ client *Client }

// List returns every app with each environment's latest plan.
func (s *AppsService) List(ctx context.Context) (*AppList, error) {
	var out AppList
	if err := s.client.do(ctx, "GET", "/apps", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListPlans returns an app's plans, newest first. environment "" and limit 0 mean unfiltered/default.
func (s *AppsService) ListPlans(ctx context.Context, repoID, environment string, limit int) (*AppPlanList, error) {
	q := url.Values{}
	if environment != "" {
		q.Set("environment", environment)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out AppPlanList
	if err := s.client.do(ctx, "GET", "/apps/"+pathEscape(repoID)+"/plans", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetPlan returns one plan.
func (s *AppsService) GetPlan(ctx context.Context, planID string) (*AppPlan, error) {
	var out AppPlan
	if err := s.client.do(ctx, "GET", "/apps/plans/"+pathEscape(planID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Confirm confirms held steps of a plan by id, then applies them. A step the
// caller may not confirm fails the call with 403.
func (s *AppsService) Confirm(ctx context.Context, planID string, actionIDs []string) (*ConfirmAppActionsResult, error) {
	var out ConfirmAppActionsResult
	if err := s.client.do(ctx, "POST", "/apps/plans/"+pathEscape(planID)+"/confirm", nil, ConfirmAppActionsBody{ActionIds: actionIDs}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetRequireApproval toggles "every step waits for confirmation" for an app.
func (s *AppsService) SetRequireApproval(ctx context.Context, repoID string, require bool) (*AppRequireApproval, error) {
	var out AppRequireApproval
	if err := s.client.do(ctx, "PUT", "/apps/"+pathEscape(repoID)+"/require-approval", nil, SetRequireApprovalBody{RequireApproval: require}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Deploy plans and applies the head of a branch now ("" = production branch).
func (s *AppsService) Deploy(ctx context.Context, repoID, branch string) (*AppDeployResult, error) {
	var out AppDeployResult
	if err := s.client.do(ctx, "POST", "/apps/"+pathEscape(repoID)+"/deploy", nil, DeployAppBody{Branch: branch}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Drift compares each environment's last applied commit with live state.
func (s *AppsService) Drift(ctx context.Context, repoID string) (*AppDriftList, error) {
	var out AppDriftList
	if err := s.client.do(ctx, "GET", "/apps/"+pathEscape(repoID)+"/drift", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetEnforceDrift opts an app in (or out) of re-applying drift on git-owned fields.
func (s *AppsService) SetEnforceDrift(ctx context.Context, repoID string, enforce bool) (*AppEnforceDrift, error) {
	var out AppEnforceDrift
	if err := s.client.do(ctx, "PUT", "/apps/"+pathEscape(repoID)+"/enforce-drift", nil, SetEnforceDriftBody{EnforceDrift: enforce}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PurgeData permanently deletes a REMOVED managed Postgres's volumes on every
// node. confirm must be exactly "<stack>/<resource>". Irreversible.
func (s *AppsService) PurgeData(ctx context.Context, repoID, environment, resource, confirm string) (*PurgeAppDataResult, error) {
	var out PurgeAppDataResult
	body := PurgeAppDataBody{Resource: resource, Confirm: confirm}
	if err := s.client.do(ctx, "POST", "/apps/"+pathEscape(repoID)+"/environments/"+pathEscape(environment)+"/purge", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Preview builds branch and deploys it as a preview stack (a trial deploy). Async (202).
func (s *AppsService) Preview(ctx context.Context, repoID, branch string) (*PreviewResult, error) {
	var out PreviewResult
	if err := s.client.do(ctx, "POST", "/apps/"+pathEscape(repoID)+"/previews", nil, CreatePreviewBody{Branch: branch}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Promote plans production with the image digests a named environment (e.g.
// "staging") runs now — no rebuild, same gates.
func (s *AppsService) Promote(ctx context.Context, repoID, from string) (*AppPromoteResult, error) {
	var out AppPromoteResult
	if err := s.client.do(ctx, "POST", "/apps/"+pathEscape(repoID)+"/promote", nil, PromoteAppBody{From: from}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
