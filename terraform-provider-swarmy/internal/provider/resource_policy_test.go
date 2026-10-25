package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// fakePoliciesAPI is /policies: the document must be a JSON object (the
// controller compiles it and answers 400 otherwise), PUT replaces the rule
// (a description left out is cleared), sentence/updated_at are derived.
type fakePoliciesAPI struct {
	mu   sync.Mutex
	seq  int
	rows map[string]map[string]any
	puts []string
}

func newFakePoliciesAPI(t *testing.T) (*fakePoliciesAPI, *httptest.Server) {
	t.Helper()
	f := &fakePoliciesAPI{rows: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		reply := func(status int, v any) { w.WriteHeader(status); _ = json.NewEncoder(w).Encode(v) }
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/policies/")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		sent, _ := json.Marshal(body)
		if body != nil {
			var doc map[string]any
			if json.Unmarshal([]byte(fmt.Sprint(body["source"])), &doc) != nil {
				reply(400, map[string]any{"title": "Bad Request", "status": 400, "detail": "invalid policy: expected a JSON object"})
				return
			}
			f.seq++
			body["sentence"], body["updated_at"] = fmt.Sprintf("%s rule %v", body["effect"], body["name"]), fmt.Sprintf("2026-10-01T00:00:%02d.000Z", f.seq)
			body["is_default"] = false
			if _, ok := body["description"]; !ok {
				body["description"] = nil
			}
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/policies":
			body["id"] = fmt.Sprintf("pol-%d", f.seq)
			f.rows[body["id"].(string)] = body
			reply(201, body)
		case f.rows[id] == nil:
			reply(404, map[string]any{"title": "Not Found", "status": 404})
		case r.Method == http.MethodGet:
			reply(200, f.rows[id])
		case r.Method == http.MethodPut:
			f.puts = append(f.puts, string(sent))
			body["id"] = id
			f.rows[id] = body
			reply(200, body)
		case r.Method == http.MethodDelete:
			delete(f.rows, id)
			reply(200, map[string]any{"id": id, "removed": true})
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func policyConfig(endpoint, body string) string {
	return fmt.Sprintf(testProvider+"resource \"swarmy_policy\" \"restart\" {\n%s\n}\n", endpoint, body)
}

const policyArgs = `  name        = "Platform restarts"
  description = "The platform group may restart any service"
  effect      = "permit"
  source      = jsonencode({ groups = ["platform"], actions = ["service.restart"], resourceTypes = ["service"] })`

func TestPolicyResourceLifecycle(t *testing.T) {
	f, srv := newFakePoliciesAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: policyConfig(srv.URL, policyArgs),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_policy.restart", "id", "pol-1"),
					resource.TestCheckResourceAttr("swarmy_policy.restart", "priority", "0"),
					resource.TestCheckResourceAttr("swarmy_policy.restart", "enabled", "true"),
					resource.TestCheckResourceAttr("swarmy_policy.restart", "sentence", "permit rule Platform restarts"),
					resource.TestCheckResourceAttr("swarmy_policy.restart", "source", `{"actions":["service.restart"],"groups":["platform"],"resourceTypes":["service"]}`),
				),
			},
			{Config: policyConfig(srv.URL, policyArgs), PlanOnly: true},
			{
				// Switched off in the dashboard: the refresh sees it.
				PreConfig: func() { f.mu.Lock(); f.rows["pol-1"]["enabled"] = false; f.mu.Unlock() },
				Config:    policyConfig(srv.URL, policyArgs), PlanOnly: true, ExpectNonEmptyPlan: true,
			},
			{
				// One PUT of the whole rule; the dropped description is cleared.
				Config: policyConfig(srv.URL, strings.Replace(strings.Replace(policyArgs, `"permit"`, `"forbid"`, 1),
					"  description = \"The platform group may restart any service\"\n", "  priority    = 10\n", 1)),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_policy.restart", "id", "pol-1"),
					resource.TestCheckNoResourceAttr("swarmy_policy.restart", "description"),
					func(*terraform.State) error {
						f.mu.Lock()
						defer f.mu.Unlock()
						if want := `{"effect":"forbid","enabled":true,"name":"Platform restarts","priority":10,"source":"{\"actions\":[\"service.restart\"],\"groups\":[\"platform\"],\"resourceTypes\":[\"service\"]}"}`; f.puts[len(f.puts)-1] != want {
							return fmt.Errorf("PUT = %s", f.puts[len(f.puts)-1])
						}
						return nil
					},
				),
			},
			{ResourceName: "swarmy_policy.restart", ImportState: true, ImportStateVerify: true},
			{
				// The controller refuses a document it can't compile; the apply fails with why.
				Config:      policyConfig(srv.URL, "  name   = \"x\"\n  effect = \"permit\"\n  source = \"not json\""),
				ExpectError: regexp.MustCompile(`invalid policy`),
			},
		},
		CheckDestroy: func(*terraform.State) error {
			if len(f.rows) != 0 {
				return fmt.Errorf("left behind: %v", f.rows)
			}
			return nil
		},
	})
}

func TestPolicyExample(t *testing.T) {
	example, err := os.ReadFile("../../examples/resources/swarmy_policy/resource.tf")
	if err != nil {
		t.Fatal(err)
	}
	_, srv := newFakePoliciesAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config: fmt.Sprintf(testProvider, srv.URL) + string(example),
			Check:  resource.TestCheckResourceAttr("swarmy_policy.no_prod_deletes", "effect", "forbid"),
		}},
	})
}
