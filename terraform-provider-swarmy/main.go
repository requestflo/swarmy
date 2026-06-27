// terraform-provider-swarmy is a Terraform provider for the swarmy public REST
// API. It lets swarms' services, stacks, ingress domains and API keys live in
// .tf and be plan/apply/destroy-ed alongside the rest of your infrastructure.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/requestflo/terraform-provider-swarmy/internal/provider"
)

// version is set at build time via -ldflags. Defaults to "dev".
var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "set to true to run the provider with support for debuggers like delve")
	flag.Parse()

	opts := providerserver.ServeOpts{
		Address: "registry.terraform.io/requestflo/swarmy",
		Debug:   debug,
	}

	if err := providerserver.Serve(context.Background(), provider.New(version), opts); err != nil {
		log.Fatal(err.Error())
	}
}
