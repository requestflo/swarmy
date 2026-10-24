package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/config"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

func ingressConfig(endpoint, body string) string {
	return fmt.Sprintf(testProvider+"resource \"swarmy_ingress\" \"edge\" {\n%s\n}\n", endpoint, body)
}

const fullIngress = `
  topology          = "edge-per-node"
  controller_image  = "ghcr.io/acme/caddy:1"
  target_nodes      = ["n1"]
  acme_email        = "ops@acme.io"
  on_demand_tls     = true
  on_demand_ask_url = "https://ctl.acme.io/ask"
  tunnel            = { run_token = "tunnel-token-0123456789", replicas = 2 }
  dns_provider      = { provider = "cloudflare", api_token = "dns-token-0123456789" }`

func TestIngressResourceLifecycle(t *testing.T) {
	f, srv := newFakeIngressAPI(t)
	last := func(check func(map[string]any) error) resource.TestCheckFunc {
		return func(*terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			return check(f.puts[len(f.puts)-1])
		}
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: ingressConfig(srv.URL, fullIngress),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_ingress.edge", "id", "org1"),
					resource.TestCheckResourceAttr("swarmy_ingress.edge", "driver", "caddy"),
					resource.TestCheckResourceAttr("swarmy_ingress.edge", "tunnel.name", "swarmy"),
					resource.TestCheckResourceAttr("swarmy_ingress.edge", "tunnel.run_token", "tunnel-token-0123456789"),
					last(func(p map[string]any) error {
						if f.token["tunnel"] != "tunnel-token-0123456789" || f.token["dns"] != "dns-token-0123456789" || p["topology"] != "edge-per-node" {
							return fmt.Errorf("create PUT = %v", p)
						}
						return nil
					}),
				),
			},
			{Config: ingressConfig(srv.URL, fullIngress), PlanOnly: true},
			{
				// Changed outside Terraform (the dashboard): the refresh sees it.
				PreConfig: func() { f.mu.Lock(); f.s["driver"] = "none"; f.mu.Unlock() },
				Config:    ingressConfig(srv.URL, fullIngress), PlanOnly: true, ExpectNonEmptyPlan: true,
			},
			{
				// A non-secret change re-sends the settings but never the tokens.
				Config: ingressConfig(srv.URL, regexp.MustCompile(`ops@acme.io`).ReplaceAllString(fullIngress, "edge@acme.io")),
				Check: last(func(p map[string]any) error {
					_, tunnel := p["tunnel"]
					_, dns := p["dns_provider"]
					if tunnel || dns || p["tls"].(map[string]any)["acme_email"] != "edge@acme.io" {
						return fmt.Errorf("update PUT = %v", p)
					}
					return nil
				}),
			},
			{
				// Unset = default: dropping everything sends the defaults, the tunnel as null.
				Config: ingressConfig(srv.URL, ""),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckNoResourceAttr("swarmy_ingress.edge", "tunnel"),
					resource.TestCheckResourceAttr("swarmy_ingress.edge", "topology", "controller"),
					last(func(p map[string]any) error {
						if v, ok := p["tunnel"]; !ok || v != nil || p["controller_image"] != nil {
							return fmt.Errorf("clearing PUT = %v", p)
						}
						return nil
					}),
				),
			},
			{ResourceName: "swarmy_ingress.edge", ImportState: true, ImportStateId: "org1", ImportStateVerify: true},
			{ResourceName: "swarmy_ingress.edge", ImportState: true, ImportStateId: "org2", ExpectError: regexp.MustCompile(`org is "org1"`)},
		},
		CheckDestroy: func(*terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			got, _ := json.Marshal(f.puts[len(f.puts)-1])
			want, _ := json.Marshal(client.DefaultIngressSettings())
			if !reflect.DeepEqual(got, want) {
				return fmt.Errorf("destroy PUT = %s, want the defaults %s", got, want)
			}
			return nil
		},
	})
}

// The shipped example applies against the fake.
func TestIngressExample(t *testing.T) {
	example, err := os.ReadFile("../../examples/resources/swarmy_ingress/resource.tf")
	if err != nil {
		t.Fatal(err)
	}
	f, srv := newFakeIngressAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:          fmt.Sprintf(testProvider, srv.URL) + string(example),
			ConfigVariables: config.Variables{"cloudflare_dns_token": config.StringVariable("cf-token-0123456789abcdef")},
			Check: func(*terraform.State) error {
				f.mu.Lock()
				defer f.mu.Unlock()
				if f.s["topology"] != "edge-per-node" || f.token["dns"] != "cf-token-0123456789abcdef" {
					return fmt.Errorf("settings = %v", f.s)
				}
				return nil
			},
		}},
	})
}
