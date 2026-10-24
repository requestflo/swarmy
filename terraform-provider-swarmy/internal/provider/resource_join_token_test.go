package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// fakeJoinTokenAPI stands in for /join-tokens: the create answers the
// plaintext once, the list never carries it and keeps revoked tokens, and an
// org that runs a mesh gets single-use tokens carrying a setup key.
type fakeJoinTokenAPI struct {
	mu      sync.Mutex
	seq     int
	mesh    bool
	tokens  []map[string]any
	creates []map[string]any
}

func newFakeJoinTokenAPI(t *testing.T) (*fakeJoinTokenAPI, *httptest.Server) {
	t.Helper()
	f := &fakeJoinTokenAPI{}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeJoinTokenAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	reply := func(status int, v any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	switch {
	case r.Method == "POST" && path == "/join-tokens":
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		f.creates = append(f.creates, body)
		f.seq++
		ttl := 3600.0
		if v, ok := body["ttl_seconds"].(float64); ok {
			ttl = v
		}
		maxUses := 1.0
		if v, ok := body["max_uses"].(float64); ok && !f.mesh {
			maxUses = v
		}
		created := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
		tok := map[string]any{
			"id":           fmt.Sprintf("jt%d", f.seq),
			"label":        body["label"],
			"profile":      body["profile"],
			"token_prefix": fmt.Sprintf("p%07d", f.seq),
			"created_at":   created.Format(time.RFC3339Nano),
			"expires_at":   created.Add(time.Duration(ttl) * time.Second).Format(time.RFC3339Nano),
			"max_uses":     maxUses,
			"used_count":   0,
			"revoked_at":   nil,
			"status":       "active",
		}
		f.tokens = append(f.tokens, tok)
		var mesh any
		if f.mesh {
			mesh = map[string]any{"setup_key": fmt.Sprintf("nbsk-%d", f.seq), "management_url": "https://mesh.example.com", "driver": "netbird"}
		}
		reply(201, map[string]any{
			"id": tok["id"], "token": fmt.Sprintf("swt_p%07d_secret", f.seq), "label": tok["label"], "profile": tok["profile"],
			"expires_at": tok["expires_at"], "max_uses": maxUses, "mesh": mesh,
			"install": map[string]any{"url": "https://swarm.example.com", "loopback": false, "warning": nil},
		})
	case r.Method == "GET" && path == "/join-tokens":
		reply(200, map[string]any{"data": f.tokens, "next_cursor": nil})
	case r.Method == "DELETE" && strings.HasPrefix(path, "/join-tokens/"):
		id := strings.TrimPrefix(path, "/join-tokens/")
		if t := f.byID(id); t != nil {
			t["status"], t["revoked_at"] = "revoked", "2026-10-02T00:00:00.000Z"
			reply(200, map[string]any{"id": id, "revoked": true})
			return
		}
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404, "swarmy_code": "NOT_FOUND"})
	default:
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404})
	}
}

// byID finds a token; the caller holds f.mu.
func (f *fakeJoinTokenAPI) byID(id string) map[string]any {
	for _, t := range f.tokens {
		if t["id"] == id {
			return t
		}
	}
	return nil
}

func (f *fakeJoinTokenAPI) locked(fn func() error) resource.TestCheckFunc {
	return func(_ *terraform.State) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		return fn()
	}
}

func joinTokenConfig(endpoint, body string) string {
	return fmt.Sprintf(testProvider+`
resource "swarmy_join_token" "workers" {
  %s
}
`, endpoint, body)
}

const joinTokenArgs = `label       = "workers"
  ttl_seconds = 600
  max_uses    = 2
  profile     = "edge"`

func TestJoinTokenResourceLifecycle(t *testing.T) {
	f, srv := newFakeJoinTokenAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: joinTokenConfig(srv.URL, joinTokenArgs),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "id", "jt1"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "token", "swt_p0000001_secret"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "install_url", "https://swarm.example.com"),
					resource.TestCheckNoResourceAttr("swarmy_join_token.workers", "mesh_setup_key"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "token_prefix", "p0000001"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "expires_at", "2026-10-01T00:10:00Z"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "max_uses", "2"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "used_count", "0"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "status", "active"),
					f.locked(func() error {
						got, _ := json.Marshal(f.creates[0])
						if string(got) != `{"label":"workers","max_uses":2,"profile":"edge","ttl_seconds":600}` {
							return fmt.Errorf("create body = %s", got)
						}
						return nil
					}),
				),
			},
			// A server joins: the refresh reads it, nothing to change.
			{
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.tokens[0]["used_count"] = 1
				},
				Config: joinTokenConfig(srv.URL, joinTokenArgs),
				Check:  resource.TestCheckResourceAttr("swarmy_join_token.workers", "used_count", "1"),
			},
			{Config: joinTokenConfig(srv.URL, joinTokenArgs), PlanOnly: true},
			// The defaults are kept, not replaced, when the arguments are dropped.
			{Config: joinTokenConfig(srv.URL, `label = "workers"
  profile = "edge"`), PlanOnly: true},
			{
				ResourceName:            "swarmy_join_token.workers",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"token", "install_url", "mesh_setup_key"},
			},
			// Revoked outside Terraform: minted again.
			{
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.tokens[0]["status"] = "revoked"
				},
				Config: joinTokenConfig(srv.URL, joinTokenArgs),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "id", "jt2"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "token", "swt_p0000002_secret"),
				),
			},
			// Any argument change mints a new token and revokes the old one.
			{
				Config: joinTokenConfig(srv.URL, `label = "workers"`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "id", "jt3"),
					resource.TestCheckNoResourceAttr("swarmy_join_token.workers", "profile"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "ttl_seconds", "3600"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "max_uses", "1"),
					f.locked(func() error {
						if f.byID("jt2")["status"] != "revoked" {
							return fmt.Errorf("replaced token jt2 not revoked")
						}
						return nil
					}),
				),
			},
		},
		CheckDestroy: func(_ *terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			for _, tok := range f.tokens {
				if tok["status"] != "revoked" {
					return fmt.Errorf("token %v left active", tok["id"])
				}
			}
			return nil
		},
	})
}

// The shipped example applies, and its install command carries the token (and
// the mesh key when the org runs a mesh).
func TestJoinTokenExample(t *testing.T) {
	example, err := os.ReadFile("../../examples/resources/swarmy_join_token/resource.tf")
	if err != nil {
		t.Fatal(err)
	}
	for _, mesh := range []bool{false, true} {
		f, srv := newFakeJoinTokenAPI(t)
		f.mesh = mesh
		want := "curl -fsSL https://swarm.example.com/install/loader.sh | SWARMY_JOIN_TOKEN=swt_p0000001_secret sh -s -- --controller https://swarm.example.com"
		if mesh {
			want = strings.Replace(want, "secret ", "secret SWARMY_MESH_SETUP_KEY=nbsk-1 ", 1)
		}
		resource.UnitTest(t, resource.TestCase{
			ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
			Steps: []resource.TestStep{{
				Config: fmt.Sprintf(testProvider, srv.URL) + string(example),
				Check:  resource.TestCheckOutput("install_command", want),
			}},
		})
	}
}

// While the org runs a mesh the token is single-use and carries a setup key;
// the configured max_uses stays in state so the plan does not churn.
func TestJoinTokenResourceMesh(t *testing.T) {
	f, srv := newFakeJoinTokenAPI(t)
	f.mesh = true
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: joinTokenConfig(srv.URL, `max_uses = 3`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "mesh_setup_key", "nbsk-1"),
					resource.TestCheckResourceAttr("swarmy_join_token.workers", "max_uses", "3"),
				),
			},
			{Config: joinTokenConfig(srv.URL, `max_uses = 3`), PlanOnly: true},
		},
	})
}
