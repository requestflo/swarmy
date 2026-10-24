package client

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

const ingressJSON = `{"org_id":"org1","driver":"caddy","enabled":true,"topology":"edge-per-node","controller_image":null,
"default_controller_image":"ghcr.io/requestflo/caddy-swarmy:latest","target_nodes":["n1"],
"tls":{"acme_email":"ops@acme.io","on_demand":false,"ask_url":null},
"tunnel":{"tunnel_id":"t1","tunnel_name":"edge","replicas":2,"run_token_set":true},"dns_provider":null,"updated_at":"2026-10-24T00:00:00.000Z"}`

func TestIngressSettingsRequests(t *testing.T) {
	var method, path, sent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		sent = string(raw)
		_, _ = w.Write([]byte(ingressJSON))
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "swk_test")
	ctx := context.Background()

	s, err := c.GetIngressSettings(ctx)
	if err != nil || method != http.MethodGet || path != "/api/v1/ingress/settings" {
		t.Fatalf("GET = %v %v, %v", method, path, err)
	}
	if s.OrgID != "org1" || s.Topology != "edge-per-node" || s.ControllerImage != nil || s.TLS.AcmeEmail == nil ||
		*s.TLS.AcmeEmail != "ops@acme.io" || s.Tunnel == nil || !s.Tunnel.RunTokenSet || s.DNSProvider != nil {
		t.Fatalf("decoded = %+v", s)
	}

	// A key left out is kept; nil is an explicit JSON null (clear).
	if _, err := c.PutIngressSettings(ctx, IngressSettingsUpdate{"enabled": false, "tunnel": nil}); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPut || sent != `{"enabled":false,"tunnel":null}` {
		t.Fatalf("PUT = %v %q", method, sent)
	}
}

func TestDefaultIngressSettingsResetsEverything(t *testing.T) {
	d := DefaultIngressSettings()
	for _, k := range []string{"driver", "enabled", "topology", "controller_image", "target_nodes", "tls", "tunnel", "dns_provider"} {
		if _, ok := d[k]; !ok {
			t.Fatalf("reset body misses %q", k)
		}
	}
	if d["driver"] != "caddy" || d["enabled"] != true || d["topology"] != "controller" || d["tunnel"] != nil {
		t.Fatalf("reset body = %v", d)
	}
}

func TestIngressSettingsPreconditionIsAProblem(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusPreconditionFailed)
		_, _ = w.Write([]byte(`{"type":"about:blank","title":"Precondition Failed","status":412,"detail":"No node is marked as an ingress node"}`))
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "swk_test")
	_, err := c.PutIngressSettings(context.Background(), IngressSettingsUpdate{"topology": "edge-per-node"})
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.StatusCode != 412 || apiErr.Problem == nil || apiErr.Problem.Detail == "" {
		t.Fatalf("err = %#v", err)
	}
}
