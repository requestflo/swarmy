package provider

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func serviceUpdateConfig(endpoint, image string, replicas int, extra string) string {
	return fmt.Sprintf(testProvider+`
resource "swarmy_service" "web" {
  name     = "web"
  image    = %q
  replicas = %d
  %s
}
`, endpoint, image, replicas, extra)
}

// lastPatch is the JSON of the newest PATCH /services/{id} body, and how many
// were sent.
func (f *fakeDeployAPI) lastPatch() (string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.patches) == 0 {
		return "", 0
	}
	raw, _ := json.Marshal(f.patches[len(f.patches)-1])
	return string(raw), len(f.patches)
}

func (f *fakeDeployAPI) expectPatch(want string, count int) resource.TestCheckFunc {
	return func(_ *terraform.State) error {
		got, n := f.lastPatch()
		if n != count || got != want {
			return fmt.Errorf("PATCH #%d = %s, want #%d = %s", n, got, count, want)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.restarts) != 0 || len(f.deletes) != 0 {
			return fmt.Errorf("update restarted %v / replaced %v the service", f.restarts, f.deletes)
		}
		return nil
	}
}

// An image, env or command change is one PATCH /services/{id} (which applies
// the new image), never /restart; a replica change on its own stays a scale.
func TestServiceUpdatesThroughPatch(t *testing.T) {
	f, srv := newFakeDeployAPI(t, 2)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: serviceUpdateConfig(srv.URL, "nginx:1.27", 1, `env = { A = "1" }`),
				Check:  resource.TestCheckResourceAttr("swarmy_service.web", "image", "nginx:1.27"),
			},
			// Image + env + replicas: one PATCH, polled to convergence.
			{
				Config: serviceUpdateConfig(srv.URL, "nginx:1.28", 2, `env = {
    B = "x"
    A = "2"
  }`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_service.web", "image", "nginx:1.28"),
					resource.TestCheckResourceAttr("swarmy_service.web", "replicas", "2"),
					resource.TestCheckResourceAttr("swarmy_service.web", "env.A", "2"),
					f.expectPatch(`{"env":[{"key":"A","value":"2"},{"key":"B","value":"x"}],"image":"nginx:1.28","replicas":2}`, 1),
					f.noEarlyReads(),
					func(_ *terraform.State) error {
						if f.polls["svc-web"] != 3 || len(f.scales) != 0 {
							return fmt.Errorf("update polled %d times (want 3), scales %v", f.polls["svc-web"], f.scales)
						}
						return nil
					},
				),
			},
			// Replicas alone: a scale, no PATCH.
			{
				Config: serviceUpdateConfig(srv.URL, "nginx:1.28", 3, `env = {
    B = "x"
    A = "2"
  }`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_service.web", "replicas", "3"),
					f.expectPatch(`{"env":[{"key":"A","value":"2"},{"key":"B","value":"x"}],"image":"nginx:1.28","replicas":2}`, 1),
					func(_ *terraform.State) error {
						if fmt.Sprint(f.scales) != "[3]" {
							return fmt.Errorf("scales = %v, want [3]", f.scales)
						}
						return nil
					},
				),
			},
			// Env removed, command added: env clears, command is sent.
			{
				Config: serviceUpdateConfig(srv.URL, "nginx:1.28", 3, `command = ["nginx", "-g", "daemon off;"]`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckNoResourceAttr("swarmy_service.web", "env"),
					f.expectPatch(`{"command":["nginx","-g","daemon off;"],"env":[]}`, 2),
				),
			},
			// Command removed: back to the image default.
			{
				Config: serviceUpdateConfig(srv.URL, "nginx:1.28", 3, ""),
				Check:  f.expectPatch(`{"command":[]}`, 3),
			},
			{
				Config:   serviceUpdateConfig(srv.URL, "nginx:1.28", 3, ""),
				PlanOnly: true,
			},
		},
	})
}

// A guardrail refusal fails the apply with every violation, and the prior
// state is kept.
func TestServiceUpdateRefusedByAdmission(t *testing.T) {
	f, srv := newFakeDeployAPI(t, 0)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{Config: serviceUpdateConfig(srv.URL, "nginx:1.27", 1, "")},
			{
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.refusePatch = map[string]any{
						"type": "https://swarmy.dev/problems/precondition_failed", "title": "Precondition Failed", "status": 412,
						"detail": "Deployment blocked by policy", "swarmy_code": "POLICY_DENIED",
						"violations": []map[string]any{{"rule": "guardrails/no-latest-tag-in-prod", "severity": "block",
							"message": "web would deploy nginx:latest to production — pin a version tag.", "resource": "web"}},
					}
				},
				Config:      serviceUpdateConfig(srv.URL, "nginx:latest", 1, ""),
				ExpectError: errRe("Error updating service", "412 (POLICY_DENIED)", "guardrails/no-latest-tag-in-prod (block)", "pin a version tag"),
			},
			{
				PreConfig: func() {
					f.mu.Lock()
					defer f.mu.Unlock()
					f.refusePatch = nil
				},
				Config:   serviceUpdateConfig(srv.URL, "nginx:1.27", 1, ""),
				PlanOnly: true,
			},
		},
	})
}
