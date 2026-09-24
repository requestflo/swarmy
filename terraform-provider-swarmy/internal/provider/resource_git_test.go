package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// fakeGitAPI is an in-memory stand-in for the swarmy /git REST routes, so the
// swarmy_git_connection / swarmy_git_repo lifecycle (create → read → import →
// destroy) runs under `go test` with a real terraform binary but no controller.
type fakeGitAPI struct {
	mu    sync.Mutex
	conns map[string]map[string]any
	repos map[string]map[string]any
	seq   int
	// lastConnBody is the most recent POST /git/connections body (write-only
	// token must be sent; the server never echoes it).
	lastConnBody map[string]any
	patches      int
}

func newFakeGitAPI(t *testing.T) (*fakeGitAPI, *httptest.Server) {
	t.Helper()
	f := &fakeGitAPI{conns: map[string]map[string]any{}, repos: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeGitAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	var body map[string]any
	if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
		_ = json.Unmarshal(raw, &body)
	}
	reply := func(status int, v any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	notFound := func() {
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404, "swarmy_code": "NOT_FOUND"})
	}
	switch {
	case r.Method == "POST" && path == "/git/connections":
		f.seq++
		f.lastConnBody = body
		id := fmt.Sprintf("gc%d", f.seq)
		base, _ := body["base_url"].(string)
		name, _ := body["display_name"].(string)
		if name == "" {
			name = "Gitea · " + strings.TrimPrefix(base, "https://")
		}
		c := map[string]any{"id": id, "kind": body["kind"], "display_name": name, "base_url": base,
			"account": nil, "status": "active", "repo_count": 0, "created_at": "2026-09-24T00:00:00.000Z"}
		f.conns[id] = c
		reply(201, c)
	case r.Method == "POST" && path == "/git/repos":
		f.seq++
		id := fmt.Sprintf("gr%d", f.seq)
		url, _ := body["url"].(string)
		cfg, _ := body["config_path"].(string)
		if cfg == "" {
			cfg = "swarmy.yaml"
		}
		f.repos[id] = map[string]any{"id": id, "kind": "generic", "url": url, "branch": body["branch"],
			"config_path": cfg, "connection_id": body["connection_id"], "full_name": nil, "autodeploy": false,
			"service_id": nil, "has_token": false, "require_approval": false, "created_at": "2026-09-24T00:00:00.000Z"}
		reply(201, map[string]any{"id": id, "url": url, "branch": body["branch"], "config_path": cfg, "full_name": nil,
			"webhook":           map[string]any{"url": "https://c/webhooks/git/" + id, "secret": "whsec_" + id},
			"deploy_key_public": nil})
	case strings.HasPrefix(path, "/git/connections/"):
		id := strings.TrimPrefix(path, "/git/connections/")
		c, ok := f.conns[id]
		if !ok {
			notFound()
			return
		}
		if r.Method == "DELETE" {
			delete(f.conns, id)
			reply(200, map[string]any{"id": id, "removed": true})
			return
		}
		reply(200, c)
	case r.Method == "GET" && path == "/apps":
		apps := []map[string]any{}
		for id, g := range f.repos {
			apps = append(apps, map[string]any{"repo_id": id, "url": g["url"], "full_name": nil, "branch": g["branch"],
				"config_path": g["config_path"], "app_name": "shop", "require_approval": g["require_approval"],
				"environments": []map[string]any{{"environment": "production", "branch": g["branch"], "stack": "shop",
					"latest_plan_id": "p1", "latest_plan_status": "applied", "latest_sha": "abc", "latest_created_at": "2026-09-24T00:00:00.000Z"}}})
		}
		reply(200, map[string]any{"data": apps, "next_cursor": nil})
	case r.Method == "PUT" && strings.HasPrefix(path, "/apps/") && strings.HasSuffix(path, "/require-approval"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/apps/"), "/require-approval")
		g, ok := f.repos[id]
		if !ok {
			notFound()
			return
		}
		g["require_approval"] = body["require_approval"]
		reply(200, map[string]any{"repo_id": id, "require_approval": body["require_approval"]})
	case strings.HasPrefix(path, "/git/repos/"):
		id := strings.TrimPrefix(path, "/git/repos/")
		g, ok := f.repos[id]
		if !ok {
			notFound()
			return
		}
		if r.Method == "PATCH" {
			f.patches++
			for k, v := range body {
				g[k] = v
			}
		}
		if r.Method == "DELETE" {
			delete(f.repos, id)
			reply(200, map[string]any{"id": id, "removed": true})
			return
		}
		reply(200, g)
	default:
		notFound()
	}
}

func gitTestConfig(endpoint string) string {
	return gitTestConfigWith(endpoint, "main", "")
}

func gitTestConfigWith(endpoint, branch, extra string) string {
	return fmt.Sprintf(`
provider "swarmy" {
  endpoint = %q
  api_key  = "swk_test_x"
}

resource "swarmy_git_connection" "gitea" {
  kind     = "gitea"
  base_url = "https://git.example.com"
  token    = "s3cret-token"
}

resource "swarmy_git_repo" "app" {
  connection_id = swarmy_git_connection.gitea.id
  url           = "https://git.example.com/acme/app.git"
  branch        = %q
  config_path   = "deploy/swarmy.yaml"
  %s
}

data "swarmy_app" "app" {
  repo_id = swarmy_git_repo.app.id
}
`, endpoint, branch, extra)
}

func TestGitResourcesLifecycle(t *testing.T) {
	f, srv := newFakeGitAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: gitTestConfig(srv.URL),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_git_connection.gitea", "id", "gc1"),
					resource.TestCheckResourceAttr("swarmy_git_connection.gitea", "display_name", "Gitea · git.example.com"),
					resource.TestCheckResourceAttr("swarmy_git_connection.gitea", "token", "s3cret-token"),
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "connection_id", "gc1"),
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "kind", "generic"),
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "config_path", "deploy/swarmy.yaml"),
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "webhook_secret", "whsec_gr2"),
					resource.TestCheckResourceAttr("data.swarmy_app.app", "app_name", "shop"),
					func(_ *terraform.State) error {
						if f.lastConnBody["token"] != "s3cret-token" {
							return fmt.Errorf("token not sent on create: %v", f.lastConnBody)
						}
						return nil
					},
				),
			},
			// Re-plan: write-only token + write-once webhook secret must not drift.
			{Config: gitTestConfig(srv.URL), PlanOnly: true},
			// branch + require_approval update IN PLACE (same id, write-once secret kept).
			{
				Config: gitTestConfigWith(srv.URL, "release", "require_approval = true"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "id", "gr2"),
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "branch", "release"),
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "require_approval", "true"),
					resource.TestCheckResourceAttr("swarmy_git_repo.app", "webhook_secret", "whsec_gr2"),
					resource.TestCheckResourceAttr("data.swarmy_app.app", "require_approval", "true"),
					resource.TestCheckResourceAttr("data.swarmy_app.app", "environments.0.latest_plan_status", "applied"),
					func(_ *terraform.State) error {
						if f.patches != 1 {
							return fmt.Errorf("expected 1 PATCH, got %d", f.patches)
						}
						return nil
					},
				),
			},
			{
				ResourceName:            "swarmy_git_connection.gitea",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"token", "token_user"},
			},
			{
				ResourceName:            "swarmy_git_repo.app",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"webhook_url", "webhook_secret", "deploy_key_public", "deploy_key", "repo_id", "clone_url"},
			},
		},
		CheckDestroy: func(_ *terraform.State) error {
			if len(f.conns)+len(f.repos) != 0 {
				return fmt.Errorf("left behind: %d connections, %d repos", len(f.conns), len(f.repos))
			}
			return nil
		},
	})
}

func TestGitResourcesValidateConfig(t *testing.T) {
	cases := []struct {
		name, body string
		want       *regexp.Regexp
	}{
		{"gitlab needs token", `resource "swarmy_git_connection" "x" { kind = "gitlab" }`, regexp.MustCompile(`Missing token`)},
		{"github is refused", `resource "swarmy_git_connection" "x" { kind = "github" }`, regexp.MustCompile(`value must be one of`)},
		{"gitea needs base_url", `resource "swarmy_git_connection" "x" { kind = "gitea" }`, regexp.MustCompile(`Missing base_url`)},
		{"repo needs url xor repo_id", `resource "swarmy_git_repo" "x" { branch = "main" }`, regexp.MustCompile(`(?i)exactly one`)},
		{"picked repo needs all three", `resource "swarmy_git_repo" "x" {
  branch  = "main"
  repo_id = "1"
}`, regexp.MustCompile(`must be configured together`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
				Steps: []resource.TestStep{{
					Config:      `provider "swarmy" {` + "\n" + `  endpoint = "https://unused.invalid"` + "\n" + `  api_key = "swk_x"` + "\n}\n" + tc.body,
					PlanOnly:    true,
					ExpectError: tc.want,
				}},
			})
		})
	}
}
