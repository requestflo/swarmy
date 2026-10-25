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

// fakeGuardrailsAPI is /guardrails with the controller's merge semantics:
// rules not named keep their state, params merge.
type fakeGuardrailsAPI struct {
	mu      sync.Mutex
	g       map[string]any
	patches []string
}

func newFakeGuardrailsAPI(t *testing.T) (*fakeGuardrailsAPI, *httptest.Server) {
	t.Helper()
	rule := func(id string, enabled bool, sev string, params map[string]any, prod bool) map[string]any {
		return map[string]any{"id": id, "enabled": enabled, "severity": sev, "params": params, "prod_only": prod}
	}
	f := &fakeGuardrailsAPI{g: map[string]any{"org_id": "org1", "production_safety_mode": false, "rules": []any{
		rule("noLatestTagInProd", true, "block", map[string]any{}, true),
		rule("minDbReplicasProd", true, "block", map[string]any{"n": 2.0}, true),
		rule("requireHealthcheck", false, "warn", map[string]any{}, false),
	}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.URL.Path != "/api/v1/guardrails" {
			w.WriteHeader(404)
			return
		}
		if r.Method == http.MethodPatch {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			raw, _ := json.Marshal(body)
			f.patches = append(f.patches, string(raw))
			f.g["production_safety_mode"] = body["production_safety_mode"]
			for _, u := range body["rules"].([]any) {
				upd := u.(map[string]any)
				live := f.rule(upd["id"].(string))
				live["enabled"], live["severity"] = upd["enabled"], upd["severity"]
				if p, ok := upd["params"].(map[string]any); ok {
					for k, v := range p {
						live["params"].(map[string]any)[k] = v
					}
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(f.g)
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

// rule finds a rule; the caller holds f.mu.
func (f *fakeGuardrailsAPI) rule(id string) map[string]any {
	for _, r := range f.g["rules"].([]any) {
		if r.(map[string]any)["id"] == id {
			return r.(map[string]any)
		}
	}
	return nil
}

func guardrailsConfig(endpoint, body string) string {
	return fmt.Sprintf(testProvider+"resource \"swarmy_guardrails\" \"org\" {\n%s\n}\n", endpoint, body)
}

const guardrailsArgs = `  production_safety_mode = true
  rules = {
    minDbReplicasProd  = { enabled = true, severity = "block", params = { n = 3 } }
    requireHealthcheck = { enabled = true, severity = "warn" }
  }`

func TestGuardrailsResourceLifecycle(t *testing.T) {
	f, srv := newFakeGuardrailsAPI(t)
	lastPatch := func(want string) resource.TestCheckFunc {
		return func(*terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if got := f.patches[len(f.patches)-1]; got != want {
				return fmt.Errorf("last PATCH = %s", got)
			}
			return nil
		}
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: guardrailsConfig(srv.URL, guardrailsArgs),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_guardrails.org", "id", "org1"),
					resource.TestCheckResourceAttr("swarmy_guardrails.org", "rules.minDbReplicasProd.params.n", "3"),
					resource.TestCheckResourceAttr("swarmy_guardrails.org", "rules.minDbReplicasProd.prod_only", "true"),
					resource.TestCheckResourceAttr("swarmy_guardrails.org", "rules.requireHealthcheck.params.%", "0"),
					resource.TestCheckNoResourceAttr("swarmy_guardrails.org", "rules.noLatestTagInProd.enabled"),
				),
			},
			{Config: guardrailsConfig(srv.URL, guardrailsArgs), PlanOnly: true},
			{
				// Changed in the dashboard: the refresh sees it; an unmanaged rule's change does not show.
				PreConfig: func() {
					f.mu.Lock()
					f.rule("requireHealthcheck")["severity"] = "block"
					f.rule("noLatestTagInProd")["enabled"] = false
					f.mu.Unlock()
				},
				Config: guardrailsConfig(srv.URL, guardrailsArgs), PlanOnly: true, ExpectNonEmptyPlan: true,
			},
			{
				Config: guardrailsConfig(srv.URL, strings.Replace(guardrailsArgs, "true\n", "false\n", 1)),
				Check: lastPatch(`{"production_safety_mode":false,"rules":[{"enabled":true,"id":"minDbReplicasProd","params":{"n":3},"severity":"block"},` +
					`{"enabled":true,"id":"requireHealthcheck","severity":"warn"}]}`),
			},
			{ResourceName: "swarmy_guardrails.org", ImportState: true, ImportStateId: "org1", ImportStateVerify: true, ImportStateVerifyIgnore: []string{"rules"}},
			{ResourceName: "swarmy_guardrails.org", ImportState: true, ImportStateId: "org2", ExpectError: regexp.MustCompile(`org is "org1"`)},
		},
		// Destroy forgets: the controller keeps the last applied guardrails.
		CheckDestroy: func(*terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.rule("requireHealthcheck")["enabled"] != true {
				return fmt.Errorf("destroy changed the guardrails: %v", f.g)
			}
			return nil
		},
	})
}

func TestGuardrailsExample(t *testing.T) {
	example, err := os.ReadFile("../../examples/resources/swarmy_guardrails/resource.tf")
	if err != nil {
		t.Fatal(err)
	}
	_, srv := newFakeGuardrailsAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config: fmt.Sprintf(testProvider, srv.URL) + string(example),
			Check:  resource.TestCheckResourceAttr("swarmy_guardrails.org", "production_safety_mode", "true"),
		}},
	})
}
