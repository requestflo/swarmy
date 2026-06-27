package provider

import (
	"context"
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
)

// testAccProtoV6ProviderFactories wires the provider for acceptance tests.
var testAccProtoV6ProviderFactories = map[string]func() (tfprotov6.ProviderServer, error){
	"swarmy": providerserver.NewProtocol6WithError(New("test")()),
}

// testAccPreCheck verifies the env vars an acceptance run needs. Acceptance
// tests only execute when TF_ACC is set and require a live swarmy controller
// reachable via SWARMY_ENDPOINT / SWARMY_API_KEY.
func testAccPreCheck(t *testing.T) {
	t.Helper()
	if os.Getenv("SWARMY_ENDPOINT") == "" {
		t.Fatal("SWARMY_ENDPOINT must be set for acceptance tests")
	}
	if os.Getenv("SWARMY_API_KEY") == "" {
		t.Fatal("SWARMY_API_KEY must be set for acceptance tests")
	}
}

// keep testAccPreCheck and the factories referenced even without acceptance
// tests compiled in, so go vet stays quiet.
var _ = testAccPreCheck
var _ = testAccProtoV6ProviderFactories

// TestProviderSchema is a fast unit test (no live server) asserting the provider
// schema builds without diagnostics.
func TestProviderSchema(t *testing.T) {
	p := New("test")()
	resp := &provider.SchemaResponse{}
	p.Schema(context.Background(), provider.SchemaRequest{}, resp)
	if resp.Diagnostics.HasError() {
		t.Fatalf("provider schema has errors: %v", resp.Diagnostics)
	}
}

// TestResourceSchemas asserts every registered resource builds a schema without
// errors.
func TestResourceSchemas(t *testing.T) {
	p := New("test")()
	for _, factory := range p.Resources(context.Background()) {
		r := factory()
		mResp := &resource.MetadataResponse{}
		r.Metadata(context.Background(), resource.MetadataRequest{ProviderTypeName: "swarmy"}, mResp)
		sResp := &resource.SchemaResponse{}
		r.Schema(context.Background(), resource.SchemaRequest{}, sResp)
		if sResp.Diagnostics.HasError() {
			t.Fatalf("resource %s schema has errors: %v", mResp.TypeName, sResp.Diagnostics)
		}
	}
}

// TestDataSourceSchemas asserts every registered data source builds a schema
// without errors.
func TestDataSourceSchemas(t *testing.T) {
	p := New("test")()
	for _, factory := range p.DataSources(context.Background()) {
		d := factory()
		mResp := &datasource.MetadataResponse{}
		d.Metadata(context.Background(), datasource.MetadataRequest{ProviderTypeName: "swarmy"}, mResp)
		sResp := &datasource.SchemaResponse{}
		d.Schema(context.Background(), datasource.SchemaRequest{}, sResp)
		if sResp.Diagnostics.HasError() {
			t.Fatalf("data source %s schema has errors: %v", mResp.TypeName, sResp.Diagnostics)
		}
	}
}
