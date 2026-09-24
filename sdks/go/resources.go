package swarmy

import (
	"context"
	"net/url"
	"strconv"
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

// Remove deletes a stack.
func (s *StacksService) Remove(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/stacks/"+pathEscape(id), nil, nil, &out); err != nil {
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
