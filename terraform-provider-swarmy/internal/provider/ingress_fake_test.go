package provider

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

// fakeIngressAPI is /ingress/settings with the controller's merge semantics:
// a key left out keeps its value, null clears; tokens are never returned.
type fakeIngressAPI struct {
	mu    sync.Mutex
	s     map[string]any
	token map[string]string // tunnel / dns token as last written
	puts  []map[string]any
	raw   []string // each PUT body exactly as sent
}

func newFakeIngressAPI(t *testing.T) (*fakeIngressAPI, *httptest.Server) {
	t.Helper()
	f := &fakeIngressAPI{s: map[string]any{}, token: map[string]string{}}
	f.apply(map[string]any(client.DefaultIngressSettings()))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.URL.Path != "/api/v1/ingress/settings" {
			w.WriteHeader(404)
			return
		}
		if r.Method == http.MethodPut {
			var body map[string]any
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &body)
			f.raw = append(f.raw, string(b))
			f.puts = append(f.puts, body)
			f.apply(body)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(f.s)
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeIngressAPI) apply(body map[string]any) {
	for k, v := range body {
		switch k {
		case "tls":
			tls, _ := f.s["tls"].(map[string]any)
			if tls == nil {
				tls = map[string]any{}
			}
			for tk, tv := range v.(map[string]any) {
				tls[tk] = tv
			}
			f.s["tls"] = tls
		case "tunnel":
			f.s["tunnel"] = nil
			if t, ok := v.(map[string]any); ok {
				f.token["tunnel"] = t["run_token"].(string)
				f.s["tunnel"] = map[string]any{"tunnel_id": "t1", "tunnel_name": t["tunnel_name"], "replicas": t["replicas"], "run_token_set": true}
			}
		case "dns_provider":
			f.s["dns_provider"] = nil
			if d, ok := v.(map[string]any); ok {
				f.token["dns"] = d["api_token"].(string)
				f.s["dns_provider"] = map[string]any{"provider": d["provider"], "api_token_set": true, "set_at": "2026-10-24T00:00:00.000Z"}
			}
		case "geoip":
			// Only the file mode keeps a path (as the controller stores it).
			g := v.(map[string]any)
			var p any
			if g["mode"] == "file" {
				p = g["path"]
			}
			f.s["geoip"] = map[string]any{"mode": g["mode"], "path": p}
		default:
			f.s[k] = v
		}
	}
	f.s["org_id"], f.s["default_controller_image"], f.s["updated_at"] = "org1", "caddy-swarmy:latest", "2026-10-24T00:00:00.000Z"
}
