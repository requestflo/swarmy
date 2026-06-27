package provider

import (
	"fmt"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

// TestAccServiceResource exercises the full create→read→update→import lifecycle
// of swarmy_service against a live controller. It only runs when TF_ACC is set
// (resource.Test skips otherwise), so plain `go build`/`go test` stay green
// without a server. Requires SWARMY_ENDPOINT and SWARMY_API_KEY (see
// testAccPreCheck).
func TestAccServiceResource(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: testAccServiceConfig("acc-web", 2),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_service.test", "name", "acc-web"),
					resource.TestCheckResourceAttr("swarmy_service.test", "replicas", "2"),
					resource.TestCheckResourceAttrSet("swarmy_service.test", "id"),
					resource.TestCheckResourceAttrSet("swarmy_service.test", "status"),
				),
			},
			{
				ResourceName:      "swarmy_service.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				Config: testAccServiceConfig("acc-web", 3),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("swarmy_service.test", "replicas", "3"),
				),
			},
		},
	})
}

func testAccServiceConfig(name string, replicas int) string {
	return fmt.Sprintf(`
provider "swarmy" {}

resource "swarmy_service" "test" {
  name     = %q
  image    = "nginx:1.27"
  replicas = %d
}
`, name, replicas)
}
