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
	"time"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

func init() {
	// Poll fast under `go test`; the defaults are seconds apart.
	deployWaitOptions = client.WaitOptions{PollInterval: 5 * time.Millisecond, NotFoundGrace: time.Second}
}

// fakeDeployAPI is an in-memory stand-in for the swarmy service, stack and
// deployment routes. Every async mutation leaves its deployment "converging"
// for `converge` polls before it answers "complete", so a resource that does
// not wait would read the object back too early.
type fakeDeployAPI struct {
	mu       sync.Mutex
	converge int
	services map[string]map[string]any // by id
	stacks   map[string]map[string]any // by id (= name)
	pending  map[string]int            // deployment id → converging polls left
	polls    map[string]int            // deployment id → polls answered
	// failPhase/failMessage make every deployment end in that phase.
	failPhase, failMessage string
	// neverConverge keeps every deployment converging (timeout tests).
	neverConverge bool
	// lastError is the service's last_error on GET /services/{id}.
	lastError string
	// events is GET /deploys/{id}/events' data.
	events []map[string]any
	// readEarly records a service/stack read made while its deployment was
	// still converging (a create/update that did not block).
	readEarly []string
	scales    []string
	deletes   []string
	restarts  []string
	// patches records each PATCH /services/{id} body.
	patches []map[string]any
	// refusePatch answers PATCH /services/{id} with this admission 412.
	refusePatch map[string]any
}

func newFakeDeployAPI(t *testing.T, converge int) (*fakeDeployAPI, *httptest.Server) {
	t.Helper()
	f := &fakeDeployAPI{
		converge: converge,
		services: map[string]map[string]any{},
		stacks:   map[string]map[string]any{},
		pending:  map[string]int{},
		polls:    map[string]int{},
	}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeDeployAPI) serviceByIDOrName(key string) map[string]any {
	if s, ok := f.services[key]; ok {
		return s
	}
	for _, s := range f.services {
		if s["name"] == key {
			return s
		}
	}
	return nil
}

func (f *fakeDeployAPI) serve(w http.ResponseWriter, r *http.Request) {
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
	seg := strings.Split(strings.Trim(path, "/"), "/")

	switch {
	case r.Method == "POST" && path == "/services":
		name, _ := body["name"].(string)
		replicas := 1.0
		if v, ok := body["replicas"].(float64); ok {
			replicas = v
		}
		id := "svc-" + name
		f.services[id] = map[string]any{"id": id, "name": name, "image": body["image"], "status": "running",
			"replicas": map[string]any{"desired": replicas, "running": replicas}, "ingress_enabled": false,
			"node_id": nil, "stack_id": nil, "updated_at": "2026-10-01T00:00:00.000Z"}
		// Like the controller: the live id is not known yet, so the ref is the name.
		f.pending[name] = f.converge
		reply(202, map[string]any{"id": name, "deployment_id": name})

	case r.Method == "POST" && len(seg) == 3 && seg[0] == "services" && (seg[2] == "scale" || seg[2] == "restart"):
		s := f.serviceByIDOrName(seg[1])
		if s == nil {
			notFound()
			return
		}
		if seg[2] == "scale" {
			s["replicas"] = map[string]any{"desired": body["replicas"], "running": body["replicas"]}
			f.scales = append(f.scales, fmt.Sprint(body["replicas"]))
		} else {
			f.restarts = append(f.restarts, seg[1])
		}
		f.pending[seg[1]] = f.converge
		reply(202, map[string]any{"id": seg[1], "deployment_id": ""})

	case r.Method == "PATCH" && len(seg) == 2 && seg[0] == "services":
		s := f.serviceByIDOrName(seg[1])
		if s == nil {
			notFound()
			return
		}
		f.patches = append(f.patches, body)
		if f.refusePatch != nil {
			w.Header().Set("Content-Type", "application/problem+json")
			reply(412, f.refusePatch)
			return
		}
		if img, ok := body["image"]; ok {
			s["image"] = img
		}
		if rep, ok := body["replicas"]; ok {
			s["replicas"] = map[string]any{"desired": rep, "running": rep}
		}
		id := s["id"].(string)
		f.pending[id] = f.converge
		reply(202, map[string]any{"id": id, "deployment_id": id})

	case len(seg) == 2 && seg[0] == "services":
		// Like the controller, a service resolves by id or name.
		s := f.serviceByIDOrName(seg[1])
		if s == nil {
			notFound()
			return
		}
		id := s["id"].(string)
		if r.Method == "DELETE" {
			delete(f.services, id)
			f.deletes = append(f.deletes, seg[1])
			reply(200, map[string]any{"id": id, "removed": true})
			return
		}
		if f.pending[s["name"].(string)] > 0 || f.pending[id] > 0 {
			f.readEarly = append(f.readEarly, path)
		}
		out := map[string]any{}
		for k, v := range s {
			out[k] = v
		}
		if f.lastError != "" {
			out["last_error"] = f.lastError
		}
		reply(200, out)

	case r.Method == "POST" && path == "/stacks":
		name, _ := body["name"].(string)
		f.stacks[name] = map[string]any{"id": name, "name": name, "service_count": 2, "status": "running",
			"updated_at": "2026-10-01T00:00:00.000Z", "compose": body["compose_source"]}
		f.pending["stack:"+name] = f.converge
		reply(202, map[string]any{"id": name, "deployment_id": "stack:" + name, "deploy_id": "dep-" + name})

	case len(seg) == 2 && seg[0] == "stacks":
		s := f.stacks[seg[1]]
		if s == nil {
			notFound()
			return
		}
		if r.Method == "DELETE" {
			delete(f.stacks, seg[1])
			f.deletes = append(f.deletes, "stack:"+seg[1])
			reply(200, map[string]any{"id": seg[1], "removed": true, "delete_data": false, "volumes_deleted": []string{}, "volumes_kept": []string{}})
			return
		}
		if f.pending["stack:"+seg[1]] > 0 {
			f.readEarly = append(f.readEarly, path)
		}
		reply(200, map[string]any{"id": s["id"], "name": s["name"], "service_count": s["service_count"], "status": s["status"], "updated_at": s["updated_at"]})

	case r.Method == "GET" && len(seg) == 2 && seg[0] == "deployments":
		id := seg[1]
		var serviceID any
		if strings.HasPrefix(id, "stack:") {
			if f.stacks[strings.TrimPrefix(id, "stack:")] == nil {
				notFound()
				return
			}
		} else {
			s := f.serviceByIDOrName(id)
			if s == nil {
				notFound()
				return
			}
			serviceID = s["id"]
		}
		f.polls[id]++
		phase, msg := "complete", any(nil)
		switch {
		case f.failPhase != "":
			phase, msg = f.failPhase, f.failMessage
		case f.neverConverge:
			phase = "converging"
		case f.pending[id] > 0:
			f.pending[id]--
			phase = "converging"
		}
		ready := 1
		if phase == "complete" {
			ready = 2
		}
		reply(200, map[string]any{"deployment_id": id, "service_id": serviceID, "kind": "deploy", "phase": phase,
			"desired": 2, "ready": ready, "message": msg, "started_at": "2026-10-01T00:00:00.000Z", "finished_at": nil})

	case r.Method == "GET" && len(seg) == 3 && seg[0] == "deploys" && seg[2] == "events":
		if f.events == nil {
			notFound()
			return
		}
		reply(200, map[string]any{"deploy_id": seg[1], "stack": "shop", "started_at": 0, "done": true, "data": f.events})

	default:
		notFound()
	}
}

const testProvider = `
provider "swarmy" {
  endpoint = %q
  api_key  = "swk_test_x"
}
`

func serviceConfig(endpoint string, replicas int, extra string) string {
	return fmt.Sprintf(testProvider+`
resource "swarmy_service" "web" {
  name     = "web"
  image    = "nginx:1.27"
  replicas = %d
  %s
}
`, endpoint, replicas, extra)
}

func stackConfig(endpoint, compose, extra string) string {
	return fmt.Sprintf(testProvider+`
resource "swarmy_stack" "shop" {
  name           = "shop"
  compose_source = %q
  %s
}
`, endpoint, compose, extra)
}

// errRe matches an error made of these fragments, in order. Terraform wraps
// diagnostics, so a space in a fragment matches any run of whitespace.
func errRe(fragments ...string) *regexp.Regexp {
	parts := make([]string, len(fragments))
	for i, f := range fragments {
		parts[i] = strings.ReplaceAll(regexp.QuoteMeta(f), " ", `\s+`)
	}
	return regexp.MustCompile(`(?s)` + strings.Join(parts, ".*"))
}

// noEarlyReads fails when a resource read its object back before the
// deployment converged.
func (f *fakeDeployAPI) noEarlyReads() resource.TestCheckFunc {
	return func(_ *terraform.State) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.readEarly) > 0 {
			return fmt.Errorf("read back before the deployment converged: %v", f.readEarly)
		}
		return nil
	}
}

func TestServiceWaitsForDeployments(t *testing.T) {
	f, srv := newFakeDeployAPI(t, 2)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: serviceConfig(srv.URL, 2, ""),
				Check: resource.ComposeAggregateTestCheckFunc(
					// The create answered the name; the deployment named the live id.
					resource.TestCheckResourceAttr("swarmy_service.web", "id", "svc-web"),
					resource.TestCheckResourceAttr("swarmy_service.web", "replicas", "2"),
					resource.TestCheckResourceAttr("swarmy_service.web", "status", "running"),
					f.noEarlyReads(),
					func(_ *terraform.State) error {
						if f.polls["web"] != 3 {
							return fmt.Errorf("create polled %d times, want 3 (2 converging + complete)", f.polls["web"])
						}
						return nil
					},
				),
			},
			// Scale answers deployment_id "": the provider polls the service id.
			{
				Config: serviceConfig(srv.URL, 3, `timeouts {
    update = "5m"
  }`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_service.web", "id", "svc-web"),
					resource.TestCheckResourceAttr("swarmy_service.web", "replicas", "3"),
					resource.TestCheckResourceAttr("swarmy_service.web", "timeouts.update", "5m"),
					f.noEarlyReads(),
					func(_ *terraform.State) error {
						if f.polls["svc-web"] != 3 || strings.Join(f.scales, ",") != "3" {
							return fmt.Errorf("scale polled %d times (want 3), scales %v", f.polls["svc-web"], f.scales)
						}
						// An unset node_id must not turn a scale into a replacement.
						if len(f.deletes) != 0 {
							return fmt.Errorf("the update replaced the service: deletes %v", f.deletes)
						}
						return nil
					},
				),
			},
			{
				ResourceName:            "swarmy_service.web",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"timeouts"},
			},
		},
		CheckDestroy: func(_ *terraform.State) error {
			if len(f.services) != 0 {
				return fmt.Errorf("left behind %d services", len(f.services))
			}
			return nil
		},
	})
}

func TestServiceFailedDeploymentFailsTheApply(t *testing.T) {
	f, srv := newFakeDeployAPI(t, 0)
	f.failPhase, f.failMessage = "failed", "task exited (1)"
	f.lastError = "No such image: nginx:1.27"
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:      serviceConfig(srv.URL, 2, ""),
			ExpectError: errRe("Deployment failed for service web", "deployment web failed", "task exited (1)", "service web: No such image: nginx:1.27"),
		}},
		// The half-made service is kept in state (tainted), so destroy removes it.
		CheckDestroy: func(_ *terraform.State) error {
			if len(f.services) != 0 || strings.Join(f.deletes, ",") != "svc-web" {
				return fmt.Errorf("services left %d, deletes %v", len(f.services), f.deletes)
			}
			return nil
		},
	})
}

func TestServiceDeploymentTimeout(t *testing.T) {
	f, srv := newFakeDeployAPI(t, 0)
	f.neverConverge = true
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config: serviceConfig(srv.URL, 2, `timeouts {
    create = "1s"
  }`),
			ExpectError: errRe("Timed out waiting for service web", "last phase converging, 1/2 ready", "timeouts block"),
		}},
	})
}

func TestStackWaitsForDeployments(t *testing.T) {
	f, srv := newFakeDeployAPI(t, 2)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: stackConfig(srv.URL, "services: {web: {image: nginx}}", ""),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_stack.shop", "id", "shop"),
					resource.TestCheckResourceAttr("swarmy_stack.shop", "service_count", "2"),
					f.noEarlyReads(),
					func(_ *terraform.State) error {
						if f.polls["stack:shop"] != 3 {
							return fmt.Errorf("deploy polled %d times, want 3", f.polls["stack:shop"])
						}
						return nil
					},
				),
			},
			{
				Config: stackConfig(srv.URL, "services: {web: {image: nginx:1.27}}", ""),
				Check: resource.ComposeAggregateTestCheckFunc(
					f.noEarlyReads(),
					func(_ *terraform.State) error {
						if f.polls["stack:shop"] != 6 {
							return fmt.Errorf("redeploy polled %d times in all, want 6", f.polls["stack:shop"])
						}
						return nil
					},
				),
			},
			{
				ResourceName:            "swarmy_stack.shop",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"compose_source", "timeouts"},
			},
		},
		CheckDestroy: func(_ *terraform.State) error {
			if len(f.stacks) != 0 {
				return fmt.Errorf("left behind %d stacks", len(f.stacks))
			}
			return nil
		},
	})
}

func TestStackFailedUpdateKeepsPriorState(t *testing.T) {
	f, srv := newFakeDeployAPI(t, 0)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{Config: stackConfig(srv.URL, "v1", "")},
			{
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.failPhase, f.failMessage = "rolledback", "update rolled back: health check failed"
					f.events = []map[string]any{
						{"seq": 1, "at": 0, "stage": "pull", "status": "done", "node": "wkr-1", "service": "shop_web", "message": "nginx is on wkr-1"},
						{"seq": 2, "at": 0, "stage": "start", "status": "failed", "node": "wkr-1", "service": "shop_web", "message": "shop_web: task: non-zero exit (137)"},
					}
				},
				Config:      stackConfig(srv.URL, "v2", ""),
				ExpectError: errRe("Deployment failed for stack shop", "stack:shop rolledback", "health check failed", "start on wkr-1: shop_web: task: non-zero exit (137)"),
			},
			{
				// The failed update kept compose_source "v1", so the next plan
				// still wants to redeploy "v2".
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.failPhase = ""
				},
				Config:             stackConfig(srv.URL, "v2", ""),
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
		},
	})
}
