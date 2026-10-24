package swarmy

import (
	"context"
	"testing"
)

func TestServicesUpdateSendsOnlySetFields(t *testing.T) {
	var cap capturedRequest
	srv := testServer(t, 202, `{"id":"svc-1","deployment_id":"svc-1"}`, &cap)
	defer srv.Close()

	ref, err := newTestClient(t, srv).Services.Update(context.Background(), "svc-1", UpdateServiceRequest{
		Image:         "nginx:1.28",
		Env:           []ServiceEnvVarInput{{Key: "LOG_LEVEL", Value: "debug"}},
		Resources:     &ServiceResources{Limits: &ServiceResourceSide{Cpus: 0.5}},
		RestartPolicy: &ServiceRestartPolicy{Condition: "on-failure", MaxAttempts: Ptr(3)},
		SetLabels:     map[string]any{"tier": "web"},
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if cap.method != "PATCH" || cap.path != "/api/v1/services/svc-1" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}
	want := `{"image":"nginx:1.28","env":[{"key":"LOG_LEVEL","value":"debug"}],"resources":{"limits":{"cpus":0.5}},"restart_policy":{"condition":"on-failure","max_attempts":3},"set_labels":{"tier":"web"}}`
	if cap.body != want {
		t.Errorf("body = %s\nwant   %s", cap.body, want)
	}
	if ref.DeploymentID != "svc-1" {
		t.Errorf("deployment_id = %q", ref.DeploymentID)
	}
}

func TestStackConnections(t *testing.T) {
	var cap capturedRequest
	srv := testServer(t, 200, `{"stack":"shop","peer":"billing","network":"swarmy-link-ab12","services":["shop_web"]}`, &cap)
	defer srv.Close()
	c := newTestClient(t, srv)

	out, err := c.Stacks.Connect(context.Background(), "shop", "billing")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if cap.method != "POST" || cap.path != "/api/v1/stacks/shop/connections" || cap.body != `{"peer":"billing"}` {
		t.Errorf("request = %s %s %s", cap.method, cap.path, cap.body)
	}
	if out.Network != "swarmy-link-ab12" || len(out.Services) != 1 {
		t.Errorf("connection = %+v", out)
	}

	if _, err := c.Stacks.Disconnect(context.Background(), "shop", "bill ing"); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}
	if cap.method != "DELETE" || cap.path != "/api/v1/stacks/shop/connections/bill%20ing" || cap.body != "" {
		t.Errorf("request = %s %s %q", cap.method, cap.path, cap.body)
	}

	srv2 := testServer(t, 200, `{"stack":"shop","connected_apps":["billing"],"services":[],"resources":[]}`, &cap)
	defer srv2.Close()
	ep, err := newTestClient(t, srv2).Stacks.Endpoints(context.Background(), "shop")
	if err != nil {
		t.Fatalf("Endpoints: %v", err)
	}
	if cap.method != "GET" || cap.path != "/api/v1/stacks/shop/endpoints" || len(ep.ConnectedApps) != 1 {
		t.Errorf("request = %s %s → %+v", cap.method, cap.path, ep)
	}
}

func TestJoinTokens(t *testing.T) {
	var cap capturedRequest
	srv := testServer(t, 201, `{"id":"jt1","token":"swt_ab12cd34_x","label":"ci","profile":null,"expires_at":"2026-10-01T01:00:00.000Z","max_uses":1,
		"mesh":{"setup_key":"nbsk","management_url":null,"driver":"netbird"},"install":{"url":"https://swarm.example.com","loopback":false,"warning":null}}`, &cap)
	defer srv.Close()
	c := newTestClient(t, srv)

	issued, err := c.JoinTokens.Create(context.Background(), CreateJoinTokenRequest{Label: "ci", TtlSeconds: 3600})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if cap.method != "POST" || cap.path != "/api/v1/join-tokens" || cap.body != `{"label":"ci","ttl_seconds":3600}` {
		t.Errorf("request = %s %s %s", cap.method, cap.path, cap.body)
	}
	if issued.Token != "swt_ab12cd34_x" || issued.Profile != nil || issued.Mesh == nil || issued.Mesh.SetupKey != "nbsk" {
		t.Errorf("issued = %+v", issued)
	}

	if _, err := c.JoinTokens.Revoke(context.Background(), "jt1"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if cap.method != "DELETE" || cap.path != "/api/v1/join-tokens/jt1" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}

	srv2 := testServer(t, 200, `{"data":[{"id":"jt1","label":null,"profile":"edge","token_prefix":"ab12cd34","created_at":"2026-10-01T00:00:00.000Z",
		"expires_at":null,"max_uses":null,"used_count":2,"revoked_at":null,"status":"active"}],"next_cursor":null}`, &cap)
	defer srv2.Close()
	list, err := newTestClient(t, srv2).JoinTokens.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list.Data) != 1 || *list.Data[0].Profile != "edge" || list.Data[0].UsedCount != 2 || list.Data[0].MaxUses != nil {
		t.Errorf("list = %+v", list)
	}
}
