package swarmy

import (
	"encoding/json"
	"testing"
)

func marshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// An optional boolean or number in a request is a pointer: nil leaves it out,
// Ptr(false) / Ptr(0) sends it. Before, omitempty dropped false and 0, so the
// Go SDK could not turn the edge off or scale a service to zero.
func TestRequestModelsSendFalseAndZero(t *testing.T) {
	got := marshal(t, UpdateIngressSettingsRequest{Enabled: Ptr(false), TLS: &IngressTlsInput{OnDemand: Ptr(false)}})
	if want := `{"enabled":false,"tls":{"on_demand":false}}`; got != want {
		t.Errorf("ingress settings = %s\nwant               %s", got, want)
	}
	if got := marshal(t, UpdateServiceRequest{Replicas: Ptr(0)}); got != `{"replicas":0}` {
		t.Errorf("service update = %s", got)
	}
	if got := marshal(t, ServiceRestartPolicy{Condition: "any", MaxAttempts: Ptr(0), DelaySeconds: Ptr(0.0)}); got != `{"condition":"any","max_attempts":0,"delay_seconds":0}` {
		t.Errorf("restart policy = %s", got)
	}
	if got := marshal(t, UpsertDnsRecordRequest{Name: "@", Type: "MX", Value: "mx.example.com", Priority: Ptr(0)}); got != `{"name":"@","type":"MX","value":"mx.example.com","priority":0}` {
		t.Errorf("dns record = %s", got)
	}
	if got := marshal(t, ServiceEnvVarInput{Key: "A", Value: "1", Secret: Ptr(false)}); got != `{"key":"A","value":"1","secret":false}` {
		t.Errorf("env var = %s", got)
	}
	if got := marshal(t, LinkGitRepoBody{URL: "https://x.dev/a.git", Branch: "main", DeployKey: Ptr(false)}); got != `{"url":"https://x.dev/a.git","branch":"main","deploy_key":false}` {
		t.Errorf("link repo = %s", got)
	}
	// Unset stays out of the body, so a partial update keeps the rest.
	if got := marshal(t, UpdateIngressSettingsRequest{}); got != `{}` {
		t.Errorf("empty ingress settings = %s", got)
	}
	if got := marshal(t, UpdateServiceRequest{Image: "nginx:1.28"}); got != `{"image":"nginx:1.28"}` {
		t.Errorf("image-only update = %s", got)
	}
}

// An optional nullable field is a Nullable: unset is left out (kept), Null
// sends null (cleared). Before, a nil pointer always sent null, so any ingress
// settings write disconnected the tunnel and cleared the DNS provider.
func TestRequestModelsNullableLeavesOutOrSendsNull(t *testing.T) {
	body := UpdateIngressSettingsRequest{
		ControllerImage: NullableValue("caddy:2.8"),
		Tunnel:          Null[IngressTunnelInput](),
		TLS:             &IngressTlsInput{AcmeEmail: Null[string]()},
	}
	if got, want := marshal(t, body), `{"controller_image":"caddy:2.8","tls":{"acme_email":null},"tunnel":null}`; got != want {
		t.Errorf("ingress settings = %s\nwant               %s", got, want)
	}
	if got := marshal(t, UpdateRegistryCredentialBody{Username: "bot"}); got != `{"username":"bot"}` {
		t.Errorf("registry update = %s", got)
	}
	if got := marshal(t, CreateApiKeyRequest{Name: "ci", StackNames: NullableValue([]string{"shop"})}); got != `{"name":"ci","stack_names":["shop"]}` {
		t.Errorf("api key = %s", got)
	}
	// A required nullable field sends null when nil: PATCH a domain's www off.
	if got := marshal(t, UpdateDomainRequest{}); got != `{"www":null}` {
		t.Errorf("domain update = %s", got)
	}
}

func TestNullableRoundTrip(t *testing.T) {
	var v struct {
		A Nullable[string] `json:"a,omitzero"`
		B Nullable[string] `json:"b,omitzero"`
		C Nullable[int]    `json:"c,omitzero"`
	}
	if err := json.Unmarshal([]byte(`{"a":null,"c":7}`), &v); err != nil {
		t.Fatal(err)
	}
	if !v.A.IsNull() || !v.B.IsZero() {
		t.Errorf("a null = %v, b unset = %v", v.A.IsNull(), v.B.IsZero())
	}
	if c, ok := v.C.Get(); !ok || c != 7 {
		t.Errorf("c = %d, %v", c, ok)
	}
	if got := marshal(t, v); got != `{"a":null,"c":7}` {
		t.Errorf("round trip = %s", got)
	}
}
