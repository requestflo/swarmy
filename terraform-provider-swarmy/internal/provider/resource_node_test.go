package provider

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// fakeNodeAPI is an in-memory stand-in for the swarmy /nodes routes. Like the
// controller, PUT /nodes/{id}/labels merges (it cannot delete a key) and the
// Node DTO reports "draining" exactly when availability is drain.
type fakeNodeAPI struct {
	mu        sync.Mutex
	nodes     map[string]map[string]any
	labels    map[string]map[string]string
	drained   map[string]bool
	labelPuts []map[string]string
	removed   []string
}

func newFakeNodeAPI(t *testing.T) (*fakeNodeAPI, *httptest.Server) {
	t.Helper()
	f := &fakeNodeAPI{
		nodes: map[string]map[string]any{
			"n1": {"id": "n1", "name": "wkr-1", "hostname": "wkr-1.internal", "role": "worker", "engine_version": "27.3.1",
				"os": "linux", "arch": "amd64", "last_seen_at": "2026-10-01T00:00:00.000Z"},
		},
		labels:  map[string]map[string]string{"n1": {"swarmy.node.ingress": "true"}},
		drained: map[string]bool{},
	}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeNodeAPI) dto(id string) map[string]any {
	out := map[string]any{}
	for k, v := range f.nodes[id] {
		out[k] = v
	}
	out["status"] = "online"
	if f.drained[id] {
		out["status"] = "draining"
	}
	return out
}

func (f *fakeNodeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	seg := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1"), "/"), "/")
	reply := func(status int, v any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	if len(seg) == 0 || seg[0] != "nodes" {
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404})
		return
	}
	if len(seg) == 1 && r.Method == "GET" {
		data := []map[string]any{}
		for id := range f.nodes {
			data = append(data, f.dto(id))
		}
		reply(200, map[string]any{"data": data, "next_cursor": nil})
		return
	}
	id := seg[1]
	if f.nodes[id] == nil {
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404, "swarmy_code": "NOT_FOUND"})
		return
	}
	switch {
	case len(seg) == 2 && r.Method == "GET":
		reply(200, f.dto(id))
	case len(seg) == 2 && r.Method == "DELETE":
		delete(f.nodes, id)
		f.removed = append(f.removed, id)
		reply(200, map[string]any{"id": id, "removed": true})
	case len(seg) == 3 && seg[2] == "labels" && r.Method == "PUT":
		var body struct {
			Labels map[string]string `json:"labels"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		f.labelPuts = append(f.labelPuts, body.Labels)
		for k, v := range body.Labels {
			f.labels[id][k] = v
		}
		reply(200, map[string]any{"id": id, "labels": body.Labels})
	case len(seg) == 3 && (seg[2] == "drain" || seg[2] == "cordon") && r.Method == "POST":
		f.drained[id] = true
		reply(200, map[string]any{"id": id, "availability": "drain"})
	case len(seg) == 3 && seg[2] == "uncordon" && r.Method == "POST":
		f.drained[id] = false
		reply(200, map[string]any{"id": id, "availability": "active"})
	default:
		reply(404, map[string]any{"type": "about:blank", "title": "Not Found", "status": 404})
	}
}

func nodeConfig(endpoint, body string) string {
	return fmt.Sprintf(testProvider+`
data "swarmy_node" "wkr" {
  name = "wkr-1"
}

resource "swarmy_node" "wkr" {
  node_id = data.swarmy_node.wkr.id
  %s
}
`, endpoint, body)
}

func TestNodeResourceLifecycle(t *testing.T) {
	f, srv := newFakeNodeAPI(t)
	check := func(fn func() error) resource.TestCheckFunc {
		return func(_ *terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			return fn()
		}
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: nodeConfig(srv.URL, `labels = {
    tier            = "edge"
    "swarmy.region" = "eu-west"
  }
  availability = "drain"`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_node.wkr", "id", "n1"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "name", "wkr-1"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "role", "worker"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "availability", "drain"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "status", "draining"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "labels.tier", "edge"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "remove_on_destroy", "false"),
					check(func() error {
						want := map[string]string{"swarmy.node.ingress": "true", "tier": "edge", "swarmy.region": "eu-west"}
						if !reflect.DeepEqual(f.labels["n1"], want) {
							return fmt.Errorf("node labels = %v, want %v (unmanaged labels kept)", f.labels["n1"], want)
						}
						return nil
					}),
				),
			},
			// Re-plan: nothing drifts.
			{
				Config: nodeConfig(srv.URL, `labels = {
    tier            = "edge"
    "swarmy.region" = "eu-west"
  }
  availability = "drain"`),
				PlanOnly: true,
			},
			// Change one label, drop another (blanked), uncordon.
			{
				Config: nodeConfig(srv.URL, `labels = {
    tier = "core"
  }
  availability = "active"`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_node.wkr", "availability", "active"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "status", "online"),
					resource.TestCheckResourceAttr("swarmy_node.wkr", "labels.%", "1"),
					check(func() error {
						last := f.labelPuts[len(f.labelPuts)-1]
						if want := map[string]string{"tier": "core", "swarmy.region": ""}; !reflect.DeepEqual(last, want) {
							return fmt.Errorf("label PUT = %v, want %v", last, want)
						}
						return nil
					}),
				),
			},
			// Drift: drained outside Terraform → the next apply uncordons.
			{
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.drained["n1"] = true
				},
				Config: nodeConfig(srv.URL, `labels = {
    tier = "core"
  }
  availability = "active"`),
				Check: resource.TestCheckResourceAttr("swarmy_node.wkr", "status", "online"),
			},
			{
				ResourceName:            "swarmy_node.wkr",
				ImportState:             true,
				ImportStateId:           "n1",
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"labels"},
			},
		},
		// Destroy only stops managing the node by default.
		CheckDestroy: func(_ *terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.nodes["n1"] == nil || len(f.removed) != 0 {
				return fmt.Errorf("node removed on destroy without remove_on_destroy: %v", f.removed)
			}
			return nil
		},
	})
}

func TestNodeResourceRemoveOnDestroy(t *testing.T) {
	f, srv := newFakeNodeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config: nodeConfig(srv.URL, `remove_on_destroy = true`),
			Check: resource.ComposeAggregateTestCheckFunc(
				// Unset availability is read, not written.
				resource.TestCheckResourceAttr("swarmy_node.wkr", "availability", "active"),
				resource.TestCheckNoResourceAttr("swarmy_node.wkr", "labels"),
			),
		}},
		CheckDestroy: func(_ *terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if strings.Join(f.removed, ",") != "n1" || len(f.labelPuts) != 0 {
				return fmt.Errorf("removed %v, label PUTs %v", f.removed, f.labelPuts)
			}
			return nil
		},
	})
}

func TestNodeResourceUnknownNode(t *testing.T) {
	_, srv := newFakeNodeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config: fmt.Sprintf(testProvider+`
resource "swarmy_node" "ghost" {
  node_id = "nope"
}
`, srv.URL),
			ExpectError: regexp.MustCompile(`Node not found`),
		}},
	})
}
