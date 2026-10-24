package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// fakeAPIKeyAPI stands in for the /api-keys routes: like the controller, the
// list carries revoked keys (status "revoked") and never a secret, and there
// is no per-key GET.
type fakeAPIKeyAPI struct {
	mu   sync.Mutex
	seq  int
	keys []map[string]any
}

func newFakeAPIKeyAPI(t *testing.T) (*fakeAPIKeyAPI, *httptest.Server) {
	t.Helper()
	f := &fakeAPIKeyAPI{}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeAPIKeyAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	reply := func(status int, v any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	switch {
	case r.Method == "POST" && path == "/api-keys":
		var body struct {
			Name   string   `json:"name"`
			Scopes []string `json:"scopes"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		f.seq++
		k := map[string]any{"id": fmt.Sprintf("key%d", f.seq), "name": body.Name, "prefix": "ab12cd34", "scopes": body.Scopes,
			"preset": "custom", "stack_names": nil, "last_used_at": nil, "expires_at": nil, "created_at": "2026-10-01T00:00:00.000Z",
			"created_by_id": "u1", "revoked_at": nil, "status": "active"}
		f.keys = append(f.keys, k)
		issued := map[string]any{"key": fmt.Sprintf("swk_ab12cd34_secret%d", f.seq)}
		for kk, v := range k {
			issued[kk] = v
		}
		reply(201, issued)
	case r.Method == "GET" && path == "/api-keys":
		reply(200, map[string]any{"data": f.keys, "next_cursor": nil})
	case r.Method == "DELETE" && strings.HasPrefix(path, "/api-keys/"):
		id := strings.TrimPrefix(path, "/api-keys/")
		for _, k := range f.keys {
			if k["id"] == id {
				f.revoke(id)
				reply(200, map[string]any{"id": id, "revoked": true})
				return
			}
		}
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404, "swarmy_code": "NOT_FOUND"})
	default:
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404})
	}
}

// revoke marks a key revoked; the caller holds f.mu.
func (f *fakeAPIKeyAPI) revoke(id string) {
	for _, k := range f.keys {
		if k["id"] == id {
			k["status"] = "revoked"
			k["revoked_at"] = "2026-10-02T00:00:00.000Z"
		}
	}
}

func apiKeyConfig(endpoint, scopes string) string {
	return fmt.Sprintf(testProvider+`
resource "swarmy_api_key" "ci" {
  name   = "ci"
  scopes = %s
}
`, endpoint, scopes)
}

func TestAPIKeyResourceLifecycle(t *testing.T) {
	f, srv := newFakeAPIKeyAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: apiKeyConfig(srv.URL, `["read", "deploy"]`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_api_key.ci", "id", "key1"),
					// The plaintext comes from the create response's `key`.
					resource.TestCheckResourceAttr("swarmy_api_key.ci", "token", "swk_ab12cd34_secret1"),
					resource.TestCheckResourceAttr("swarmy_api_key.ci", "scopes.#", "2"),
				),
			},
			// Read (list + filter) finds the key: no drift.
			{Config: apiKeyConfig(srv.URL, `["read", "deploy"]`), PlanOnly: true},
			// Revoked outside Terraform: gone from state, so a new key is minted.
			{
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.revoke("key1")
				},
				Config: apiKeyConfig(srv.URL, `["read", "deploy"]`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_api_key.ci", "id", "key2"),
					resource.TestCheckResourceAttr("swarmy_api_key.ci", "token", "swk_ab12cd34_secret2"),
				),
			},
			// A scope change replaces the key (revoke + mint).
			{
				Config: apiKeyConfig(srv.URL, `["read"]`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_api_key.ci", "id", "key3"),
					resource.TestCheckResourceAttr("swarmy_api_key.ci", "scopes.#", "1"),
					func(_ *terraform.State) error {
						f.mu.Lock()
						defer f.mu.Unlock()
						if f.keys[1]["status"] != "revoked" {
							return fmt.Errorf("replaced key not revoked: %v", f.keys[1])
						}
						return nil
					},
				),
			},
			{
				ResourceName:            "swarmy_api_key.ci",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"token"},
			},
		},
		CheckDestroy: func(_ *terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			for _, k := range f.keys {
				if k["status"] != "revoked" {
					return fmt.Errorf("key %v left active", k["id"])
				}
			}
			return nil
		},
	})
}
