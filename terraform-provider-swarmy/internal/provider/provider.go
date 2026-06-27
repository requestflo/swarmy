// Package provider implements the swarmy Terraform provider on the modern
// terraform-plugin-framework. It wires the typed REST client (internal/client)
// to Terraform resources and data sources.
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

// Environment variables read as fallbacks for the provider config attributes.
const (
	envEndpoint = "SWARMY_ENDPOINT"
	envAPIKey   = "SWARMY_API_KEY"
)

// Ensure swarmyProvider satisfies the provider.Provider interface.
var _ provider.Provider = (*swarmyProvider)(nil)

// swarmyProvider is the provider implementation.
type swarmyProvider struct {
	version string
}

// swarmyProviderModel maps the provider configuration block.
type swarmyProviderModel struct {
	Endpoint types.String `tfsdk:"endpoint"`
	APIKey   types.String `tfsdk:"api_key"`
}

// New returns a provider factory bound to the given build version.
func New(version string) func() provider.Provider {
	return func() provider.Provider {
		return &swarmyProvider{version: version}
	}
}

func (p *swarmyProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "swarmy"
	resp.Version = p.version
}

func (p *swarmyProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manage swarmy services, stacks, ingress domains and API keys via the swarmy public REST API.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				Optional:    true,
				Description: "Base URL of the swarmy controller, e.g. https://controller.example.com. May also be set with the " + envEndpoint + " environment variable.",
			},
			"api_key": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				Description: "swarmy API key (swk_…) used as the bearer token. May also be set with the " + envAPIKey + " environment variable.",
			},
		},
	}
}

func (p *swarmyProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg swarmyProviderModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if cfg.Endpoint.IsUnknown() {
		resp.Diagnostics.AddAttributeError(
			rootPath("endpoint"),
			"Unknown swarmy endpoint",
			"The endpoint cannot be determined at plan time. Set it statically or via the "+envEndpoint+" environment variable.",
		)
	}
	if cfg.APIKey.IsUnknown() {
		resp.Diagnostics.AddAttributeError(
			rootPath("api_key"),
			"Unknown swarmy API key",
			"The api_key cannot be determined at plan time. Set it statically or via the "+envAPIKey+" environment variable.",
		)
	}
	if resp.Diagnostics.HasError() {
		return
	}

	endpoint := os.Getenv(envEndpoint)
	if !cfg.Endpoint.IsNull() {
		endpoint = cfg.Endpoint.ValueString()
	}
	apiKey := os.Getenv(envAPIKey)
	if !cfg.APIKey.IsNull() {
		apiKey = cfg.APIKey.ValueString()
	}

	if endpoint == "" {
		resp.Diagnostics.AddAttributeError(
			rootPath("endpoint"),
			"Missing swarmy endpoint",
			"Set the endpoint attribute or the "+envEndpoint+" environment variable.",
		)
	}
	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(
			rootPath("api_key"),
			"Missing swarmy API key",
			"Set the api_key attribute or the "+envAPIKey+" environment variable.",
		)
	}
	if resp.Diagnostics.HasError() {
		return
	}

	c, err := client.New(endpoint, apiKey)
	if err != nil {
		resp.Diagnostics.AddError("Invalid swarmy provider configuration", err.Error())
		return
	}

	resp.DataSourceData = c
	resp.ResourceData = c
}

func (p *swarmyProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewServiceResource,
		NewStackResource,
		NewDomainResource,
		NewAPIKeyResource,
	}
}

func (p *swarmyProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewNodeDataSource,
	}
}
