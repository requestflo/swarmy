package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.Resource                = (*domainResource)(nil)
	_ resource.ResourceWithConfigure   = (*domainResource)(nil)
	_ resource.ResourceWithImportState = (*domainResource)(nil)
)

// domainResource manages swarmy_domain.
type domainResource struct {
	client *client.Client
}

// domainModel is the Terraform state model for swarmy_domain.
type domainModel struct {
	ID         types.String `tfsdk:"id"`
	Host       types.String `tfsdk:"host"`
	ServiceID  types.String `tfsdk:"service_id"`
	TargetPort types.Int64  `tfsdk:"target_port"`
	TLS        types.String `tfsdk:"tls"`
	PathPrefix types.String `tfsdk:"path_prefix"`
}

// NewDomainResource is the resource factory.
func NewDomainResource() resource.Resource {
	return &domainResource{}
}

func (r *domainResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_domain"
}

func (r *domainResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *domainResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "An ingress domain pairing a host with a swarmy service, port and TLS mode. The REST API has no update endpoint, so any change replaces the domain.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "Ingress domain ID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"host": schema.StringAttribute{
				Required:      true,
				Description:   "The hostname to route, e.g. app.example.com.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"service_id": schema.StringAttribute{
				Required:      true,
				Description:   "ID of the service to route traffic to.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"target_port": schema.Int64Attribute{
				Required:    true,
				Description: "Service container port to forward to (1-65535).",
			},
			"tls": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "TLS mode: auto, off, or custom. Defaults to auto.",
				Validators: []validator.String{
					stringvalidator.OneOf("auto", "off", "custom"),
				},
			},
			"path_prefix": schema.StringAttribute{
				Optional:    true,
				Description: "Optional path prefix the route matches.",
			},
		},
	}
}

func (r *domainResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan domainModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	body := client.AddDomainRequest{
		Host:       plan.Host.ValueString(),
		ServiceID:  plan.ServiceID.ValueString(),
		TargetPort: plan.TargetPort.ValueInt64(),
		TLS:        valueToStringPtr(plan.TLS),
		PathPrefix: valueToStringPtr(plan.PathPrefix),
	}

	d, err := r.client.AddDomain(ctx, body)
	if err != nil {
		resp.Diagnostics.AddError("Error creating ingress domain", err.Error())
		return
	}

	r.mapDomainToState(d, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *domainResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state domainModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	d, err := r.client.GetDomain(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading ingress domain", err.Error())
		return
	}

	r.mapDomainToState(d, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Update only ever runs for target_port/tls/path_prefix changes (host/service_id
// force replacement). The REST API has no domain update endpoint, so we delete
// and recreate to apply the new attributes, preserving the resource address.
func (r *domainResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state domainModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	if err := r.client.DeleteDomain(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Error replacing ingress domain (delete step)", err.Error())
		return
	}

	d, err := r.client.AddDomain(ctx, client.AddDomainRequest{
		Host:       plan.Host.ValueString(),
		ServiceID:  plan.ServiceID.ValueString(),
		TargetPort: plan.TargetPort.ValueInt64(),
		TLS:        valueToStringPtr(plan.TLS),
		PathPrefix: valueToStringPtr(plan.PathPrefix),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error replacing ingress domain (create step)", err.Error())
		return
	}

	r.mapDomainToState(d, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *domainResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state domainModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteDomain(ctx, state.ID.ValueString()); err != nil {
		if client.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Error deleting ingress domain", err.Error())
	}
}

func (r *domainResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

func (r *domainResource) mapDomainToState(d *client.Domain, m *domainModel) {
	m.ID = types.StringValue(d.ID)
	m.Host = types.StringValue(d.Host)
	m.ServiceID = types.StringValue(d.ServiceID)
	m.TargetPort = types.Int64Value(d.TargetPort)
	m.TLS = types.StringValue(d.TLS)
	m.PathPrefix = stringPtrToValue(d.PathPrefix)
}
