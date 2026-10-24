package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
)

// Schema: every setting has its default, so an unset one goes back to it.
// Only the tokens are write-only (sensitive, kept from state on read).
func (r *ingressResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	str := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{Optional: true, Description: desc}
	}
	resp.Schema = schema.Schema{
		Description: "The org's ingress (edge) settings — one per org, the API key's. The configuration is the whole truth: a setting left unset goes to its default. Every apply is one write and the edge converges once. Destroying the resource puts every setting back to its default (swarmy's Caddy, enabled, the replicated controller, the default image, no pin, no ACME email, no on-demand TLS, no tunnel, no DNS provider); switching topology back removes and recreates the edge service.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, Description: "The org id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"driver": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("caddy"),
				Description: "caddy (swarmy runs Caddy on 80/443), cloudflared (a Cloudflare Tunnel) or none (your own proxy). Default caddy.",
				Validators:  []validator.String{stringvalidator.OneOf("caddy", "cloudflared", "none")}},
			"enabled": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true), Description: "Whether the edge serves. Default true."},
			"topology": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("controller"),
				Description: "controller (one replicated Caddy) or edge-per-node (a Caddy on every ingress node; needs an ingress-labelled node and swarmy object storage). A change removes and recreates the edge service. Default controller.",
				Validators:  []validator.String{stringvalidator.OneOf("controller", "edge-per-node")}},
			"controller_image":         str("Caddy image both topologies run. Unset = default_controller_image."),
			"default_controller_image": schema.StringAttribute{Computed: true, Description: "The image run when controller_image is unset."},
			"target_nodes": schema.ListAttribute{Optional: true, Computed: true, ElementType: types.StringType,
				Default:     listdefault.StaticValue(types.ListValueMust(types.StringType, nil)),
				Description: "Node ids the replicated controller is pinned to. Default none."},
			"acme_email":        str("ACME account email (certificate expiry notices)."),
			"on_demand_tls":     schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false), Description: "Issue certificates on demand for customer domains; needs acme_email or on_demand_ask_url. Default false."},
			"on_demand_ask_url": str("The endpoint Caddy asks before issuing a certificate on demand."),
			"tunnel": schema.SingleNestedAttribute{Optional: true, Description: "The Cloudflare tunnel. Unset = none (disconnects one connected elsewhere).",
				Attributes: map[string]schema.Attribute{
					"run_token": schema.StringAttribute{Required: true, Sensitive: true, Description: "The tunnel's run token (write-only; encrypted at rest). The tunnel id is read from it."},
					"name":      schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("swarmy"), Description: "Default swarmy."},
					"replicas": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(1), Description: "Connector replicas, 1-10. Default 1.",
						Validators: []validator.Int64{int64validator.Between(1, 10)}},
				}},
			"dns_provider": schema.SingleNestedAttribute{Optional: true, Description: "BYO DNS provider for wildcard certificates in zones swarmy DNS does not serve. Unset = none.",
				Attributes: map[string]schema.Attribute{
					"provider":  schema.StringAttribute{Required: true, Description: "cloudflare.", Validators: []validator.String{stringvalidator.OneOf("cloudflare")}},
					"api_token": schema.StringAttribute{Required: true, Sensitive: true, Description: "Provider API token, Zone:DNS:Edit (write-only; kept only in a Docker secret)."},
				}},
		},
	}
}
