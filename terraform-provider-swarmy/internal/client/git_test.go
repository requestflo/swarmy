package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLinkGitRepoBodyAndWriteOnceFields(t *testing.T) {
	var gotPath string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.Method + " " + r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.WriteHeader(201)
		_, _ = io.WriteString(w, `{"id":"r1","url":"git@x.dev:a/b.git","branch":"main","config_path":"swarmy.yaml","full_name":null,"webhook":{"url":"https://c/webhooks/git/r1","secret":"whsec_x"},"deploy_key_public":"ssh-ed25519 AAA"}`)
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "swk_test")

	u := "git@x.dev:a/b.git"
	dk := true
	out, err := c.LinkGitRepo(context.Background(), LinkGitRepoRequest{URL: &u, Branch: "main", DeployKey: &dk})
	if err != nil {
		t.Fatalf("LinkGitRepo: %v", err)
	}
	if gotPath != "POST /api/v1/git/repos" {
		t.Fatalf("request = %q", gotPath)
	}
	for _, k := range []string{"repo", "connection_id", "config_path"} {
		if _, ok := body[k]; ok {
			t.Errorf("absent %q must be omitted: %v", k, body)
		}
	}
	if out.Webhook == nil || out.Webhook.Secret != "whsec_x" || out.DeployKeyPublic == nil {
		t.Fatalf("write-once fields not decoded: %+v", out)
	}
}

func TestCreateGitConnectionBrowserFlowProblem(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(422)
		_, _ = io.WriteString(w, `{"type":"about:blank","title":"Unprocessable Content","status":422,"detail":"use the dashboard","swarmy_code":"BROWSER_FLOW_REQUIRED"}`)
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "swk_test")

	_, err := c.CreateGitConnection(context.Background(), CreateGitConnectionRequest{Kind: "github"})
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.StatusCode != 422 || apiErr.Problem == nil || apiErr.Problem.SwarmyCode != "BROWSER_FLOW_REQUIRED" {
		t.Fatalf("err = %#v", err)
	}
}
