package client

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// ---- Git connections + linked repos (/git/*) ----
//
// Only the non-browser connection kinds are creatable over the API (GitLab
// token, Gitea, generic). GitHub App and GitLab OAuth connections are made in
// the dashboard and return 422 (swarmy_code BROWSER_FLOW_REQUIRED) here.

// GitConnection mirrors the GitConnection DTO. Credentials are never returned.
type GitConnection struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"`
	DisplayName string  `json:"display_name"`
	BaseURL     string  `json:"base_url"`
	Account     *string `json:"account"`
	Status      string  `json:"status"`
	RepoCount   int64   `json:"repo_count"`
	CreatedAt   string  `json:"created_at"`
}

// CreateGitConnectionRequest is the body for POST /git/connections. Token is
// write-only.
type CreateGitConnectionRequest struct {
	Kind        string  `json:"kind"`
	Mode        *string `json:"mode,omitempty"`
	BaseURL     *string `json:"base_url,omitempty"`
	DisplayName *string `json:"display_name,omitempty"`
	Token       *string `json:"token,omitempty"`
	TokenUser   *string `json:"token_user,omitempty"`
}

// GitRepo mirrors the GitRepo DTO (a linked repository; no secrets).
type GitRepo struct {
	ID              string  `json:"id"`
	Kind            string  `json:"kind"`
	URL             string  `json:"url"`
	Branch          string  `json:"branch"`
	ConfigPath      string  `json:"config_path"`
	ConnectionID    *string `json:"connection_id"`
	FullName        *string `json:"full_name"`
	Autodeploy      bool    `json:"autodeploy"`
	ServiceID       *string `json:"service_id"`
	HasToken        bool    `json:"has_token"`
	RequireApproval bool    `json:"require_approval"`
	CreatedAt       string  `json:"created_at"`
}

// GitRepoRef is a provider repo picked from GET /git/connections/{id}/repos.
type GitRepoRef struct {
	ID       string `json:"id"`
	FullName string `json:"full_name"`
	CloneURL string `json:"clone_url"`
}

// LinkGitRepoRequest is the body for POST /git/repos. Give exactly one of Repo
// or URL.
type LinkGitRepoRequest struct {
	ConnectionID *string     `json:"connection_id,omitempty"`
	Repo         *GitRepoRef `json:"repo,omitempty"`
	URL          *string     `json:"url,omitempty"`
	Branch       string      `json:"branch"`
	ConfigPath   *string     `json:"config_path,omitempty"`
	DeployKey    *bool       `json:"deploy_key,omitempty"`
}

// GitRepoWebhook is the generic webhook swarmy could not register itself.
type GitRepoWebhook struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
}

// LinkedGitRepo is the 201 payload of POST /git/repos. Webhook and
// DeployKeyPublic are WRITE-ONCE: no read returns them again.
type LinkedGitRepo struct {
	ID              string          `json:"id"`
	URL             string          `json:"url"`
	Branch          string          `json:"branch"`
	ConfigPath      string          `json:"config_path"`
	FullName        *string         `json:"full_name"`
	Webhook         *GitRepoWebhook `json:"webhook"`
	DeployKeyPublic *string         `json:"deploy_key_public"`
}

// CreateGitConnection connects a token-based git host.
func (c *Client) CreateGitConnection(ctx context.Context, body CreateGitConnectionRequest) (*GitConnection, error) {
	var out GitConnection
	if err := c.post(ctx, "/git/connections", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetGitConnection reads a git connection by ID.
func (c *Client) GetGitConnection(ctx context.Context, id string) (*GitConnection, error) {
	var out GitConnection
	if err := c.get(ctx, "/git/connections/"+url.PathEscape(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteGitConnection removes a git connection.
func (c *Client) DeleteGitConnection(ctx context.Context, id string) error {
	return c.delete(ctx, "/git/connections/"+url.PathEscape(id), nil)
}

// LinkGitRepo links a repository as an app binding.
func (c *Client) LinkGitRepo(ctx context.Context, body LinkGitRepoRequest) (*LinkedGitRepo, error) {
	var out LinkedGitRepo
	if err := c.post(ctx, "/git/repos", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetGitRepo reads a linked repository by ID.
func (c *Client) GetGitRepo(ctx context.Context, id string) (*GitRepo, error) {
	var out GitRepo
	if err := c.get(ctx, "/git/repos/"+url.PathEscape(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteGitRepo unlinks a repository.
func (c *Client) DeleteGitRepo(ctx context.Context, id string) error {
	return c.delete(ctx, "/git/repos/"+url.PathEscape(id), nil)
}

// UpdateGitRepoRequest is the body for PATCH /git/repos/{id}.
type UpdateGitRepoRequest struct {
	Branch     *string `json:"branch,omitempty"`
	ConfigPath *string `json:"config_path,omitempty"`
}

// UpdateGitRepo changes a linked repository's branch and/or config path in place.
func (c *Client) UpdateGitRepo(ctx context.Context, id string, body UpdateGitRepoRequest) (*GitRepo, error) {
	var out GitRepo
	if err := c.do(ctx, http.MethodPatch, "/git/repos/"+url.PathEscape(id), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- GitOps apps (/apps/*) ----

// AppEnvironment is one environment of an app with its latest plan summary.
type AppEnvironment struct {
	Environment      string  `json:"environment"`
	Branch           string  `json:"branch"`
	Stack            string  `json:"stack"`
	LatestPlanID     *string `json:"latest_plan_id"`
	LatestPlanStatus *string `json:"latest_plan_status"`
	LatestSha        *string `json:"latest_sha"`
	LatestCreatedAt  *string `json:"latest_created_at"`
}

// App mirrors the App DTO (a linked repo as a GitOps app).
type App struct {
	RepoID          string           `json:"repo_id"`
	URL             string           `json:"url"`
	FullName        *string          `json:"full_name"`
	Branch          string           `json:"branch"`
	ConfigPath      string           `json:"config_path"`
	AppName         *string          `json:"app_name"`
	RequireApproval bool             `json:"require_approval"`
	Environments    []AppEnvironment `json:"environments"`
}

// ListApps returns every GitOps app (single page).
func (c *Client) ListApps(ctx context.Context) ([]App, error) {
	var env listEnvelope[App]
	if err := c.get(ctx, "/apps", &env); err != nil {
		return nil, err
	}
	return env.Data, nil
}

// GetApp returns the app for a linked repo. The API exposes only the list, so
// this filters it client-side (404 APIError when absent).
func (c *Client) GetApp(ctx context.Context, repoID string) (*App, error) {
	apps, err := c.ListApps(ctx)
	if err != nil {
		return nil, err
	}
	for i := range apps {
		if apps[i].RepoID == repoID {
			return &apps[i], nil
		}
	}
	return nil, &APIError{StatusCode: 404, RawBody: fmt.Sprintf("app for repo %q not found", repoID)}
}

// SetAppRequireApproval sets the app's require-approval toggle.
func (c *Client) SetAppRequireApproval(ctx context.Context, repoID string, require bool) error {
	body := struct {
		RequireApproval bool `json:"require_approval"`
	}{require}
	return c.do(ctx, http.MethodPut, "/apps/"+url.PathEscape(repoID)+"/require-approval", body, nil)
}
