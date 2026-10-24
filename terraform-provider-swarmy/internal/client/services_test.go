package client

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUpdateServiceSendsOnlySetFields(t *testing.T) {
	var method, path, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"svc-1","deployment_id":"svc-1"}`))
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "swk_test")

	img := "nginx:1.28"
	env := []EnvVar{}
	ref, err := c.UpdateService(context.Background(), "svc-1", UpdateServiceRequest{Image: &img, Env: &env})
	if err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPatch || path != "/api/v1/services/svc-1" {
		t.Fatalf("request = %s %s", method, path)
	}
	// Unset replicas/command are left out; an empty env is sent (it clears).
	if body != `{"image":"nginx:1.28","env":[]}` {
		t.Fatalf("body = %s", body)
	}
	if ref.DeploymentID != "svc-1" {
		t.Fatalf("ref = %+v", ref)
	}
}

func TestAdmissionRefusalListsViolations(t *testing.T) {
	err := parseError(412, []byte(`{"type":"https://swarmy.dev/problems/precondition_failed","title":"Precondition Failed","status":412,
		"detail":"Deployment blocked by policy","swarmy_code":"POLICY_DENIED",
		"violations":[{"rule":"guardrails/no-latest-tag-in-prod","severity":"block","message":"pin a version tag","resource":"web"},
		{"rule":"guardrails/require-healthcheck","severity":"warn","message":"no healthcheck"}]}`))
	want := "swarmy API error 412 (POLICY_DENIED): Precondition Failed: Deployment blocked by policy\n" +
		"  - guardrails/no-latest-tag-in-prod (block): pin a version tag\n" +
		"  - guardrails/require-healthcheck (warn): no healthcheck"
	if err.Error() != want {
		t.Fatalf("error =\n%s\nwant\n%s", err.Error(), want)
	}
}
