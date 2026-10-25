package provider

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// Optional booleans must reach the API as false, not be dropped: the SDK's
// omitempty bug would have sent nothing and left the edge on.
func TestIngressSendsFalse(t *testing.T) {
	f, srv := newFakeIngressAPI(t)
	sent := func(want ...string) resource.TestCheckFunc {
		return func(*terraform.State) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			raw := f.raw[len(f.raw)-1]
			for _, w := range want {
				if !strings.Contains(raw, w) {
					return fmt.Errorf("PUT %s lacks %s", raw, w)
				}
			}
			return nil
		}
	}
	on := "enabled = true\n  on_demand_tls = true\n  acme_email = \"ops@acme.io\""
	off := "enabled = false\n  on_demand_tls = false\n  acme_email = \"ops@acme.io\""
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{Config: ingressConfig(srv.URL, off), Check: resource.ComposeAggregateTestCheckFunc(
				sent(`"enabled":false`, `"on_demand":false`),
				resource.TestCheckResourceAttr("swarmy_ingress.edge", "enabled", "false"),
			)},
			{Config: ingressConfig(srv.URL, on), Check: sent(`"enabled":true`, `"on_demand":true`)},
			// true → false is a real change, sent as false.
			{Config: ingressConfig(srv.URL, off), Check: resource.ComposeAggregateTestCheckFunc(
				sent(`"enabled":false`, `"on_demand":false`),
				func(*terraform.State) error {
					f.mu.Lock()
					defer f.mu.Unlock()
					if f.s["enabled"] != false || f.s["tls"].(map[string]any)["on_demand"] != false {
						return fmt.Errorf("settings = %v", f.s)
					}
					return nil
				},
			)},
			{Config: ingressConfig(srv.URL, off), PlanOnly: true},
		},
	})
}

func TestIngressValidateConfig(t *testing.T) {
	_, srv := newFakeIngressAPI(t)
	step := func(body, why string) resource.TestStep {
		return resource.TestStep{Config: ingressConfig(srv.URL, body), PlanOnly: true, ExpectError: regexp.MustCompile(why)}
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			step(`geoip_mode = "file"`, `Missing country database path`),
			step(`geoip_mode = "off"`+"\n"+`geoip_path = "/geo/c.mmdb"`, `only used with geoip_mode = "file"`),
			step(`geoip_mode = "nearby"`, `value must be one of`),
			step(`auto_address_base = "NIP.io"`, `lowercase domain name`),
		},
	})
}

// A refused apply names every refused field (the API's invalid_params).
func TestIngressRefusalNamesEachField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"about:blank","title":"Bad Request","status":400,
"detail":"invalid ingress settings: tls.onDemand: on-demand TLS requires an ACME email or an ask endpoint; autoAddressBase: x",
"invalid_params":[{"name":"tls.on_demand","reason":"on-demand TLS requires an ACME email or an ask endpoint"},
{"name":"auto_address_base","reason":"not a wildcard-IP DNS service"}]}`))
	}))
	t.Cleanup(srv.Close)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config:      ingressConfig(srv.URL, "on_demand_tls = true"),
			ExpectError: regexp.MustCompile(`(?s)tls\.on_demand: on-demand TLS requires.*auto_address_base: not a wildcard-IP`),
		}},
	})
}
